// simdrive iOS helper: drives a booted simulator from the host through Apple's simulator frameworks.
// Nothing is installed on the simulator and there is no XCTest/WebDriverAgent in the loop.
//
//   screen tree   AccessibilityPlatformTranslation (AXPTranslator), bridged through
//                 -[SimDevice sendAccessibilityRequestAsync:…]
//   touch + keys  Xcode ≤ 26: SimulatorKit's SimDeviceLegacyHIDClient with Indigo HID messages
//                 Xcode 27+: XPC messages to the guest's dtuhidd digitizer service
//   frames        the main display's framebuffer IOSurface (CoreSimulator SimDeviceIOClient)
//
// These are private APIs: everything is looked up at runtime (dlopen + NSClassFromString), so one
// binary builds without private headers, and a missing piece is reported rather than crashing.
// Indigo message layouts and the dtuhidd wire format follow facebook/idb (MIT):
// PrivateHeaders/SimulatorApp/Indigo.h, FBSimulatorControl/HID/SimulatorIndigoHID.swift,
// DTUHIDModels.swift, SimulatorDTUHIDConnection.swift and XPC/SimulatorXPCConnection.swift.
//
// Protocol (unix socket): one JSON request per line. Each reply is one JSON line; a reply carrying
// "bytes": N is followed by N raw bytes (a PNG).
//
// build: clang -fobjc-arc -O2 -framework Foundation -framework AppKit -framework IOSurface \
//          -framework ImageIO -framework CoreGraphics -framework UniformTypeIdentifiers simdrive-sim.m

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <dlfcn.h>
#import <objc/message.h>
#import <mach/mach_time.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <unistd.h>
#import <xpc/xpc.h>

// Selectors on runtime-only classes. Declared once so the compiler knows their signatures.
@protocol SimPrivate
+ (id)sharedServiceContextForDeveloperDir:(NSString *)dir error:(NSError **)error;
- (id)defaultDeviceSetWithError:(NSError **)error;
- (NSArray *)devices;
- (NSUUID *)UDID;
- (long long)state;
- (id)deviceType;
- (CGSize)mainScreenSize;
- (float)mainScreenScale;
- (id)io;
- (NSArray *)ioPorts;
- (id)descriptor;
- (unsigned short)displayClass;
- (id)framebufferSurface;
- (id)initWithDevice:(id)device error:(NSError **)error;
- (void)sendWithMessage:(void *)message freeWhenDone:(BOOL)free completionQueue:(dispatch_queue_t)queue completion:(void (^)(NSError *))completion;
- (unsigned int)lookup:(NSString *)service error:(NSError **)error;
- (void)sendAccessibilityRequestAsync:(id)request completionQueue:(dispatch_queue_t)queue completionHandler:(void (^)(id))handler;
+ (id)sharedInstance;
+ (id)emptyResponse;
- (void)setBridgeTokenDelegate:(id)delegate;
- (id)frontmostApplicationWithDisplayId:(unsigned int)display bridgeDelegateToken:(NSString *)token;
- (id)macPlatformElementFromTranslation:(id)translation;
- (id)objectAtPoint:(CGPoint)point displayId:(unsigned int)display bridgeDelegateToken:(NSString *)token;
- (id)translation;
- (void)setBridgeDelegateToken:(NSString *)token;
@end

static const long long SimDeviceStateBooted = 3;

static id device;           // SimDevice
static id translator;       // AXPTranslator
static NSString *axToken;   // routes translator requests to this device
static id hidClient;        // SimDeviceLegacyHIDClient
static CGSize screenPx;     // main screen, pixels
static float screenScale;   // pixels per point
static NSString *version = @"dev";
static int probes; // hit-tests made by the last tree read
static dispatch_queue_t hidQueue;

typedef void *(*MouseEventFn)(CGPoint *, CGPoint *, uint32_t, unsigned long, CGSize, uint32_t);
typedef void *(*KeyboardFn)(int32_t, int32_t);
static MouseEventFn indigoMouse;
static KeyboardFn indigoKeyboard;

static void die(NSString *msg) {
  fprintf(stderr, "simdrive-sim: %s\n", msg.UTF8String);
  exit(2);
}

// ── accessibility bridge ─────────────────────────────────────────────────

@interface AXBridge : NSObject
@end

@implementation AXBridge
// AXPTranslator calls this synchronously; CoreSimulator answers asynchronously on another queue.
- (id)accessibilityTranslationDelegateBridgeCallbackWithToken:(NSString *)token {
  return ^id(id request) {
    __block id response = nil;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    [device sendAccessibilityRequestAsync:request
                          completionQueue:dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0)
                        completionHandler:^(id r) {
                          response = r;
                          dispatch_semaphore_signal(done);
                        }];
    dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
    return response ?: [NSClassFromString(@"AXPTranslatorResponse") emptyResponse];
  };
}
// Frames come back in device points, top-left origin; keep them that way.
- (CGRect)accessibilityTranslationConvertPlatformFrameToSystem:(CGRect)rect withToken:(NSString *)token {
  return rect;
}
- (id)accessibilityTranslationRootParentWithToken:(NSString *)token {
  return nil;
}
@end

static AXBridge *bridge;

static NSString *str(id v) {
  if (!v || v == NSNull.null) return @"";
  return [v isKindOfClass:NSString.class] ? v : [v description];
}

/** One element as a row: {l: label, t: type, id, v: value, x, y, w, h} in points. */
static NSMutableDictionary *row(id el, NSRect f) {
  NSString *role = str([el accessibilityRole]);
  if ([role hasPrefix:@"AX"]) role = [role substringFromIndex:2];
  NSMutableDictionary *n = [@{
    @"l" : str([el accessibilityLabel]),
    @"t" : role,
    @"x" : @(round(f.origin.x)), @"y" : @(round(f.origin.y)),
    @"w" : @(round(f.size.width)), @"h" : @(round(f.size.height)),
  } mutableCopy];
  NSString *ident = str([el accessibilityIdentifier]);
  if (ident.length) n[@"id"] = ident;
  NSString *value = str([el accessibilityValue]);
  if (value.length) n[@"v"] = value;
  return n;
}

static CGRect frameOf(NSDictionary *n) {
  return CGRectMake([n[@"x"] doubleValue], [n[@"y"] doubleValue], [n[@"w"] doubleValue], [n[@"h"] doubleValue]);
}

/**
 Pre-order walk. Some containers report no children although they draw some — iOS 26's floating
 search toolbar is one — so childless containers are collected in `holes` and hit-tested afterwards.
 */
static void walk(id el, NSMutableArray *out, NSMutableArray *holes, BOOL all, CGRect screen) {
  [[el translation] setBridgeDelegateToken:axToken];
  NSRect f = [el accessibilityFrame];
  BOOL onScreen = f.size.width > 0 && f.size.height > 0 && CGRectIntersectsRect(f, screen);
  NSMutableDictionary *n = (all || onScreen) ? row(el, f) : nil;
  if (n) [out addObject:n];
  NSArray *children = [el accessibilityChildren];
  if (n && !children.count && ([n[@"t"] isEqualToString:@"Group"] || [n[@"t"] isEqualToString:@"GenericElement"]))
    [holes addObject:[NSValue valueWithRect:CGRectIntersection(f, screen)]];
  for (id child in children) walk(child, out, holes, all, screen);
}

/** Hit-test a grid over `hole`, adding elements the walk could not reach. */
static void fillHole(CGRect hole, NSMutableArray *out) {
  const double step = 20;
  // The software keyboard's container is empty too, but its keys are already in the tree beside it.
  // (Other overlap proves nothing: a floating toolbar sits on top of the list rows scrolling under it.)
  for (NSDictionary *m in out) {
    NSString *ident = m[@"id"];
    if (([ident isEqualToString:@"shift"] || [ident isEqualToString:@"delete"] || [ident isEqualToString:@"space"]) &&
        CGRectIntersectsRect(frameOf(m), hole))
      return;
  }
  NSMutableArray<NSValue *> *covered = [NSMutableArray array];
  for (double y = CGRectGetMinY(hole) + step / 2; y < CGRectGetMaxY(hole); y += step) {
    for (double x = CGRectGetMinX(hole) + step / 2; x < CGRectGetMaxX(hole); x += step) {
      CGPoint p = CGPointMake(x, y);
      BOOL skip = NO;
      for (NSValue *c in covered)
        if (CGRectContainsPoint(c.rectValue, p)) skip = YES;
      if (skip) continue;
      probes++;
      id o = [translator objectAtPoint:p displayId:0 bridgeDelegateToken:axToken];
      if (!o) continue;
      [o setBridgeDelegateToken:axToken];
      id el = [translator macPlatformElementFromTranslation:o];
      [[el translation] setBridgeDelegateToken:axToken];
      NSRect f = [el accessibilityFrame];
      if (f.size.width <= 0 || f.size.height <= 0 || CGRectEqualToRect(NSRectToCGRect(f), hole) || CGRectContainsRect(f, hole)) {
        [covered addObject:[NSValue valueWithRect:CGRectMake(x - step / 2, y - step / 2, step, step)]];
        continue;
      }
      [covered addObject:[NSValue valueWithRect:f]];
      NSMutableDictionary *n = row(el, f);
      BOOL dup = NO;
      for (NSDictionary *m in out)
        if (CGRectEqualToRect(frameOf(m), frameOf(n)) && [m[@"l"] isEqualToString:n[@"l"]]) dup = YES;
      if (!dup) [out addObject:n];
    }
  }
}

static NSArray *readTree(BOOL all) {
  id app = [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:axToken];
  if (!app) return @[];
  [app setBridgeDelegateToken:axToken];
  id root = [translator macPlatformElementFromTranslation:app];
  NSMutableArray *out = [NSMutableArray array], *holes = [NSMutableArray array];
  CGRect screen = CGRectMake(0, 0, screenPx.width / screenScale, screenPx.height / screenScale);
  probes = 0;
  if (root) walk(root, out, holes, all, screen);
  for (NSValue *h in holes) {
    fillHole(h.rectValue, out);
  }
  return out;
}

/** Root only (content not reported yet), or something clipped at a side edge (a push/pop in flight). */
static BOOL looksMidTransition(NSArray *nodes, double screenW) {
  if (nodes.count <= 1) return YES;
  for (NSUInteger i = 1; i < nodes.count; i++) {
    CGRect f = frameOf(nodes[i]);
    if (CGRectGetMinX(f) < 0 || CGRectGetMaxX(f) > screenW + 0.5) return YES;
  }
  return NO;
}

static BOOL sameFrames(NSArray *a, NSArray *b) {
  if (a.count != b.count) return NO;
  for (NSUInteger i = 0; i < a.count; i++)
    if (!CGRectEqualToRect(frameOf(a[i]), frameOf(b[i]))) return NO;
  return YES;
}

/**
 The tree, read once when the screen looks settled. Mid-transition (see looksMidTransition) it is
 re-read every 50 ms until two reads agree, at most 1.5 s — so a carousel resting half off-screen
 costs one extra read, and a navigation in flight is not reported as a mix of two screens.
 */
static NSArray *tree(BOOL all, BOOL settle) {
  NSArray *nodes = readTree(all);
  double screenW = screenPx.width / screenScale;
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1.5];
  while (settle && looksMidTransition(nodes, screenW) && deadline.timeIntervalSinceNow > 0) {
    usleep(50000);
    NSArray *next = readTree(all);
    BOOL stable = next.count > 1 && sameFrames(nodes, next);
    nodes = next;
    if (stable) break;
  }
  return nodes;
}

/** The software keyboard's keys carry stable, unlocalized identifiers. */
static BOOL keyboardShown(void) {
  for (NSDictionary *n in tree(NO, NO)) {
    NSString *ident = n[@"id"];
    if ([ident isEqualToString:@"delete"] || [ident isEqualToString:@"space"] || [ident isEqualToString:@"shift"]) return YES;
  }
  return NO;
}

/** The loaded CoreSimulator's version (e.g. "1048"), which decides the HID transport. */
static NSString *coreSimulatorVersion(void) {
  Class c = NSClassFromString(@"SimDevice");
  return c ? [NSBundle bundleForClass:c].infoDictionary[@"CFBundleVersion"] : nil;
}

// ── HID ──────────────────────────────────────────────────────────────────
//
// Two transports, chosen by the loaded CoreSimulator (see chooseTransport):
//   indigo  SimulatorKit's SimDeviceLegacyHIDClient + Indigo messages. CoreSimulator < 1155.4 (Xcode ≤ 26).
//   dtuhid  plain-XPC messages to the guest's `dtuhidd` digitizer service. CoreSimulator ≥ 1155.4
//           (Xcode 27), whose guest silently drops Indigo input.
// Both expose the same primitives: touch start/move/end, key down/up, and sync (wait until delivered).

typedef enum { TouchStart = 0, TouchMove = 1, TouchEnd = 2 } TouchPhase; // = dtuhidd's eventType

static NSString *transport;     // "indigo" | "dtuhid"
static NSString *inputError;    // set when input cannot work; reported by every input op

static CGPoint ratioFor(double x, double y) {
  return CGPointMake(x * screenScale / screenPx.width, y * screenScale / screenPx.height);
}

// ── Indigo ──

static dispatch_group_t indigoPending;
static NSError *indigoFailure;

static void indigoSend(void *message) {
  dispatch_group_enter(indigoPending);
  [hidClient sendWithMessage:message
                freeWhenDone:YES
             completionQueue:hidQueue
                  completion:^(NSError *e) {
                    if (e && !indigoFailure) indigoFailure = e;
                    dispatch_group_leave(indigoPending);
                  }];
}

/**
 A single-finger touch at (x, y) points. SimulatorKit only builds multi-touch messages, so take the
 contact from IndigoHIDMessageForMouseNSEvent and re-envelope it as a single-touch (eventType 2)
 message with two payloads, as idb does. Offsets: Indigo.h. A move is another touch-down.
 */
static void *touchMessage(double x, double y, BOOL down) {
  CGPoint ratio = ratioFor(x, y);
  char *src = indigoMouse(&ratio, NULL, 0x32, down ? 1 : 2, CGSizeMake(1, 1), 0);
  *(double *)(src + 0x3c) = ratio.x; // payload.event.touch.xRatio
  *(double *)(src + 0x44) = ratio.y; // payload.event.touch.yRatio
  char *m = calloc(1, 0x140);
  *(uint32_t *)(m + 0x18) = 0x90;               // innerSize
  *(uint8_t *)(m + 0x1c) = 2;                   // eventType: single touch
  *(uint32_t *)(m + 0x20) = 0xB;                // payload.eventKind
  *(uint64_t *)(m + 0x24) = mach_absolute_time(); // payload.timestamp
  memcpy(m + 0x30, src + 0x30, 0x70);           // IndigoTouch
  free(src);
  memcpy(m + 0xB0, m + 0x20, 0x90);             // second payload = copy of the first
  *(uint32_t *)(m + 0xC0) = 1;                  // its touch.field1
  *(uint32_t *)(m + 0xC4) = 2;                  // its touch.field2
  return m;
}

// ── DTUHID (Xcode 27) ── wire format: facebook/idb FBSimulatorControl/HID/DTUHIDModels.swift

static NSString *const DTU_SERVICE = @"com.apple.coredevice.feature.remote.hid.digitizer";
static xpc_connection_t dtuConnection;

typedef xpc_object_t (*EndpointFromPortFn)(mach_port_t, uint64_t, uint64_t);
typedef xpc_connection_t (*ConnectionFromEndpointFn)(xpc_object_t);
typedef void (*EnableSim2HostFn)(xpc_connection_t);

/** The envelope dtuhidd decodes: messageType, isBarrier, featureIdentifier, payload. */
static xpc_object_t dtuMessage(const char *type, xpc_object_t payload, BOOL barrier) {
  xpc_object_t m = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(m, "messageType", type);
  xpc_dictionary_set_bool(m, "isBarrier", barrier);
  xpc_dictionary_set_string(m, "featureIdentifier", DTU_SERVICE.UTF8String);
  xpc_dictionary_set_value(m, "payload", payload);
  return m;
}

/** IndigoKeyboardButtonEvent: USB HID usage, state 1 = down, 2 = up (0 is rejected). */
static xpc_object_t dtuKeyMessage(int usage, BOOL down, BOOL barrier) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usageCode", (uint64_t)usage);
  xpc_dictionary_set_uint64(p, "state", down ? 1 : 2);
  return dtuMessage("IndigoKeyboardButtonEvent", p, barrier);
}

/** IndigoDigitizerEvent: one contact in normalized top-left coordinates, eventType start/position/end. */
static xpc_object_t dtuTouchMessage(TouchPhase phase, double x, double y) {
  CGPoint r = ratioFor(x, y);
  xpc_object_t pt = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(pt, "x", r.x);
  xpc_dictionary_set_double(pt, "y", r.y);
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(p, "pointOne", pt);
  xpc_dictionary_set_uint64(p, "eventType", (uint64_t)phase);
  xpc_dictionary_set_uint64(p, "edge", 0);
  xpc_dictionary_set_uint64(p, "target", 0);
  return dtuMessage("IndigoDigitizerEvent", p, NO);
}

/**
 A barrier: keyboard usage 0 ("no event"), answered once dtuhidd has taken everything sent before it.
 Also the liveness probe — a lookup and sends all succeed against a daemon that cannot run.
 */
static BOOL dtuBarrier(double timeout) {
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block BOOL ok = NO;
  xpc_connection_send_message_with_reply(dtuConnection, dtuKeyMessage(0, NO, YES), hidQueue, ^(xpc_object_t reply) {
    ok = xpc_get_type(reply) == XPC_TYPE_DICTIONARY;
    dispatch_semaphore_signal(done);
  });
  return dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC))) == 0 && ok;
}

/** Host connection to the guest's dtuhidd: look the service up in the simulator, wrap the port for sim→host. */
static NSString *dtuConnect(void) {
  EndpointFromPortFn endpointFromPort = (EndpointFromPortFn)dlsym(RTLD_DEFAULT, "xpc_endpoint_create_mach_port_4sim");
  ConnectionFromEndpointFn fromEndpoint = (ConnectionFromEndpointFn)dlsym(RTLD_DEFAULT, "xpc_connection_create_from_endpoint");
  EnableSim2HostFn enableSim2Host = (EnableSim2HostFn)dlsym(RTLD_DEFAULT, "xpc_connection_enable_sim2host_4sim");
  if (!endpointFromPort || !fromEndpoint || !enableSim2Host) return @"this macOS has no simulator XPC endpoints (xpc_*_4sim)";
  // dtuhidd is demand-launched and can abort early in a slow boot; launchd throttles its respawn.
  NSString *why = nil;
  for (int attempt = 0; attempt < 3; attempt++) {
    if (attempt) sleep(4);
    NSError *err = nil;
    mach_port_t port = [device lookup:DTU_SERVICE error:&err];
    // No such service is permanent for this runtime (it predates dtuhidd): don't retry it.
    if (port == MACH_PORT_NULL)
      return [NSString stringWithFormat:@"the simulator has no %@ (%@)", DTU_SERVICE, err.localizedDescription ?: @"lookup failed"];
    xpc_object_t endpoint = endpointFromPort(port, 0, 0);
    xpc_connection_t c = endpoint ? fromEndpoint(endpoint) : NULL;
    if (!c) return @"could not create an XPC connection to dtuhidd";
    enableSim2Host(c); // without it the service sees the peer but never a payload
    xpc_connection_set_target_queue(c, hidQueue);
    xpc_connection_set_event_handler(c, ^(xpc_object_t event) {
      // Interruptions reconnect on the next send; nothing to do.
    });
    xpc_connection_resume(c);
    dtuConnection = c;
    if (dtuBarrier(4)) {
      usleep(200000); // device-open tail after the daemon activates
      return nil;
    }
    xpc_connection_cancel(c);
    dtuConnection = NULL;
    why = @"dtuhidd did not answer (it may still be starting — retry in a few seconds)";
  }
  return why;
}

// ── primitives ──

static NSDate *dtuRetryAfter;

static void requireInput(void) {
  // A dtuhidd that would not answer gets another chance after a pause, not on every event.
  if ([transport isEqualToString:@"dtuhid"] && !dtuConnection && (!dtuRetryAfter || dtuRetryAfter.timeIntervalSinceNow <= 0)) {
    inputError = dtuConnect();
    dtuRetryAfter = inputError ? [NSDate dateWithTimeIntervalSinceNow:10] : nil;
  }
  if (inputError) [NSException raise:@"hid" format:@"input unavailable (%@): %@", transport, inputError];
}

static void touch(TouchPhase phase, double x, double y) {
  requireInput();
  if (dtuConnection) xpc_connection_send_message(dtuConnection, dtuTouchMessage(phase, x, y));
  else indigoSend(touchMessage(x, y, phase != TouchEnd));
}

static void keyEvent(int usage, BOOL down) {
  requireInput();
  if (dtuConnection) xpc_connection_send_message(dtuConnection, dtuKeyMessage(usage, down, NO));
  else indigoSend(indigoKeyboard(usage, down ? 1 : 2));
}

/** Wait until everything sent so far has been taken by the simulator, so the next read sees its effect. */
static void hidSync(void) {
  if (dtuConnection) {
    if (!dtuBarrier(2)) [NSException raise:@"hid" format:@"dtuhidd did not acknowledge input"];
    return;
  }
  dispatch_group_wait(indigoPending, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
  if (indigoFailure) {
    NSError *e = indigoFailure;
    indigoFailure = nil;
    [NSException raise:@"hid" format:@"HID send failed: %@", e.localizedDescription];
  }
}

static void tap(double x, double y, int holdMs) {
  touch(TouchStart, x, y);
  hidSync();
  if (holdMs > 0) usleep(holdMs * 1000);
  touch(TouchEnd, x, y);
  hidSync();
}

/** idb's swipe: a contact every ~10 points, one more at the end (stops inertial scroll), then up. */
static void swipe(double x1, double y1, double x2, double y2, int ms) {
  double dist = hypot(x2 - x1, y2 - y1);
  int steps = MAX(1, (int)(dist / 10));
  useconds_t gap = (useconds_t)(ms * 1000.0 / (steps + 2));
  touch(TouchStart, x1, y1);
  for (int i = 1; i <= steps; i++) {
    usleep(gap);
    touch(TouchMove, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps);
  }
  usleep(gap);
  touch(TouchMove, x2, y2);
  touch(TouchEnd, x2, y2);
  hidSync();
}

// HID keyboard usages (page 7).
enum { KEY_ENTER = 40, KEY_ESCAPE = 41, KEY_BACKSPACE = 42, KEY_TAB = 43, KEY_SPACE = 44, KEY_SHIFT = 225, KEY_CMD = 227 };

/** Usage for a character on a US layout, and whether it needs shift. False if it has none. */
static BOOL usageFor(unichar c, int *usage, BOOL *shift) {
  *shift = NO;
  if (c >= 'a' && c <= 'z') return *usage = 4 + (c - 'a'), YES;
  if (c >= 'A' && c <= 'Z') return *usage = 4 + (c - 'A'), *shift = YES, YES;
  if (c >= '1' && c <= '9') return *usage = 30 + (c - '1'), YES;
  if (c == '0') return *usage = 39, YES;
  static const char *plain = "\n\t -=[]\\;'`,./";
  static const int plainUsage[] = {KEY_ENTER, KEY_TAB, KEY_SPACE, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56};
  static const char *shifted = "!@#$%^&*()_+{}|:\"~<>?";
  static const int shiftedUsage[] = {30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56};
  for (int i = 0; plain[i]; i++)
    if (c == (unichar)plain[i]) return *usage = plainUsage[i], YES;
  for (int i = 0; shifted[i]; i++)
    if (c == (unichar)shifted[i]) return *usage = shiftedUsage[i], *shift = YES, YES;
  return NO;
}

/** Press `usage` with modifiers held. */
static void press(int usage, NSArray<NSNumber *> *modifiers) {
  for (NSNumber *m in modifiers) keyEvent(m.intValue, YES);
  keyEvent(usage, YES);
  keyEvent(usage, NO);
  for (NSNumber *m in modifiers.reverseObjectEnumerator) keyEvent(m.intValue, NO);
  hidSync();
}

static void typeString(NSString *s) {
  for (NSUInteger i = 0; i < s.length; i++) {
    int usage;
    BOOL shift;
    if (!usageFor([s characterAtIndex:i], &usage, &shift))
      [NSException raise:@"text" format:@"cannot type %C on a US keyboard layout", [s characterAtIndex:i]];
    press(usage, shift ? @[ @(KEY_SHIFT) ] : @[]);
  }
}

/** Named keys, or a raw HID usage number. "selectall" is Cmd-A, "paste" Cmd-V. */
static void key(NSString *name) {
  NSDictionary *named = @{
    @"return" : @(KEY_ENTER), @"enter" : @(KEY_ENTER), @"escape" : @(KEY_ESCAPE), @"delete" : @(KEY_BACKSPACE),
    @"backspace" : @(KEY_BACKSPACE), @"tab" : @(KEY_TAB), @"space" : @(KEY_SPACE),
  };
  NSString *k = name.lowercaseString;
  if ([k isEqualToString:@"selectall"]) return press(4, @[ @(KEY_CMD) ]);
  if ([k isEqualToString:@"paste"]) return press(25, @[ @(KEY_CMD) ]);
  NSNumber *u = named[k];
  if (!u && k.integerValue > 0) u = @(k.integerValue);
  if (!u) [NSException raise:@"key" format:@"unknown key: %@", name];
  press(u.intValue, @[]);
}

// ── frames ───────────────────────────────────────────────────────────────

/** The main display's IOSurface: the port whose descriptor reports displayClass 0. */
static IOSurfaceRef mainSurface(void) {
  id fallback = nil;
  for (id port in [[device io] ioPorts]) {
    id d = [port descriptor];
    if (![d respondsToSelector:@selector(framebufferSurface)]) continue;
    // The descriptor's `state` is an object (SimDisplayDescriptorState), unlike SimDevice's.
    id state = [d respondsToSelector:@selector(state)] ? ((id(*)(id, SEL))objc_msgSend)(d, @selector(state)) : nil;
    if (state && [state respondsToSelector:@selector(displayClass)] && [state displayClass] == 0) {
      fallback = d;
      break;
    }
    if (!fallback) fallback = d;
  }
  id surface = [fallback framebufferSurface];
  return (__bridge IOSurfaceRef)surface; // toll-free bridged; kept alive by the descriptor
}

static NSData *png(IOSurfaceRef s) {
  IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL);
  size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s), stride = IOSurfaceGetBytesPerRow(s);
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGDataProviderRef dp = CGDataProviderCreateWithData(NULL, IOSurfaceGetBaseAddress(s), stride * h, NULL);
  CGImageRef img = CGImageCreate(w, h, 8, 32, stride, cs, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst, dp, NULL, NO,
                                 kCGRenderingIntentDefault);
  NSMutableData *out = [NSMutableData data];
  CGImageDestinationRef dst = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)out, (__bridge CFStringRef)UTTypePNG.identifier, 1, NULL);
  CGImageDestinationAddImage(dst, img, NULL);
  CGImageDestinationFinalize(dst);
  CFRelease(dst);
  CGImageRelease(img);
  CGDataProviderRelease(dp);
  CGColorSpaceRelease(cs);
  IOSurfaceUnlock(s, kIOSurfaceLockReadOnly, NULL);
  return out;
}

// ── server ───────────────────────────────────────────────────────────────

static void writeAll(int fd, const void *buf, size_t len) {
  const char *p = buf;
  while (len) {
    ssize_t n = write(fd, p, len);
    if (n <= 0) return;
    p += n, len -= (size_t)n;
  }
}

static void reply(int fd, NSDictionary *head, NSData *body) {
  NSMutableDictionary *h = [head mutableCopy];
  if (body) h[@"bytes"] = @(body.length);
  NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:h options:0 error:nil] mutableCopy];
  [line appendBytes:"\n" length:1];
  writeAll(fd, line.bytes, line.length);
  if (body) writeAll(fd, body.bytes, body.length);
}

static double num(NSDictionary *r, NSString *k, double dflt) {
  id v = r[k];
  return [v isKindOfClass:NSNumber.class] ? [v doubleValue] : dflt;
}

/** Frames whenever the surface changes (its seed moves), for `seconds`. */
static void burst(int fd, double seconds) {
  uint32_t lastSeed = UINT32_MAX;
  int frames = 0, sent = 0;
  NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
  while (end.timeIntervalSinceNow > 0) {
    IOSurfaceRef s = mainSurface();
    uint32_t seed = s ? IOSurfaceGetSeed(s) : lastSeed;
    frames++;
    if (s && seed != lastSeed) {
      lastSeed = seed;
      reply(fd, @{@"frame" : @(++sent), @"ms" : @(round(-end.timeIntervalSinceNow * 1000))}, png(s));
    }
    usleep(16000);
  }
  reply(fd, @{@"ok" : @YES, @"done" : @YES, @"frames" : @(frames), @"distinct" : @(sent)}, nil);
}

static void handle(int fd, NSDictionary *r) {
  NSString *op = r[@"op"];
  if ([op isEqualToString:@"hello"]) return reply(fd, @{
    @"ok" : @YES, @"version" : version, @"pid" : @(getpid()), @"input" : transport ?: @"",
    @"coreSimulator" : coreSimulatorVersion() ?: @"", @"inputError" : inputError ?: @""
  }, nil);
  if ([op isEqualToString:@"tree"]) {
    NSArray *nodes = tree([r[@"all"] boolValue], ![r[@"settle"] isEqual:@NO]);
    return reply(fd, @{@"ok" : @YES, @"nodes" : nodes, @"probes" : @(probes)}, nil);
  }
  if ([op isEqualToString:@"tap"]) {
    tap(num(r, @"x", 0), num(r, @"y", 0), (int)num(r, @"hold", 50));
    return reply(fd, @{@"ok" : @YES}, nil);
  }
  if ([op isEqualToString:@"swipe"]) {
    swipe(num(r, @"x1", 0), num(r, @"y1", 0), num(r, @"x2", 0), num(r, @"y2", 0), (int)num(r, @"ms", 150));
    return reply(fd, @{@"ok" : @YES}, nil);
  }
  if ([op isEqualToString:@"text"]) {
    typeString(r[@"s"] ?: @"");
    return reply(fd, @{@"ok" : @YES}, nil);
  }
  if ([op isEqualToString:@"key"]) {
    for (NSString *k in r[@"keys"]) key(k);
    return reply(fd, @{@"ok" : @YES}, nil);
  }
  if ([op isEqualToString:@"keyboard"]) return reply(fd, @{@"ok" : @YES, @"shown" : @(keyboardShown())}, nil);
  if ([op isEqualToString:@"shot"]) {
    IOSurfaceRef s = mainSurface();
    if (!s) return reply(fd, @{@"ok" : @NO, @"error" : @"no framebuffer for the main display"}, nil);
    return reply(fd, @{@"ok" : @YES}, png(s));
  }
  if ([op isEqualToString:@"burst"]) return burst(fd, num(r, @"seconds", 5));
  if ([op isEqualToString:@"stop"]) {
    reply(fd, @{@"ok" : @YES}, nil);
    exit(0);
  }
  reply(fd, @{@"ok" : @NO, @"error" : [NSString stringWithFormat:@"unknown op: %@", op]}, nil);
}

static void serve(int fd) {
  FILE *in = fdopen(dup(fd), "r");
  char *line = NULL;
  size_t cap = 0;
  static dispatch_queue_t work;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ work = dispatch_queue_create("simdrive.work", DISPATCH_QUEUE_SERIAL); });
  while (getline(&line, &cap, in) > 0) {
    @autoreleasepool {
      NSData *data = [NSData dataWithBytes:line length:strlen(line)];
      NSDictionary *req = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
      if (![req isKindOfClass:NSDictionary.class]) continue;
      // One request at a time across all clients: the translator and HID client are not reentrant.
      dispatch_sync(work, ^{
        @try {
          handle(fd, req);
        } @catch (NSException *e) {
          reply(fd, @{@"ok" : @NO, @"error" : e.reason ?: e.name}, nil);
        }
      });
    }
  }
  free(line);
  fclose(in);
  close(fd);
}

/**
 From CoreSimulator 1155.4 (Xcode 27) the guest drops Indigo input for the whole boot, delivered or
 not, so it has to be dtuhidd — idb's rule. SIMDRIVE_IOS_HID=indigo|dtuhid overrides it.
 Input problems are recorded in `inputError`, not fatal: reading the screen still works.
 */
static void chooseTransport(void *simKit) {
  const char *forced = getenv("SIMDRIVE_IOS_HID");
  NSString *v = coreSimulatorVersion();
  BOOL modern = v && [v compare:@"1155.4" options:NSNumericSearch] != NSOrderedAscending;
  transport = forced && *forced ? @(forced) : modern ? @"dtuhid" : @"indigo";
  if ([transport isEqualToString:@"dtuhid"]) return; // connected on first input (dtuhidd is demand-launched)
  if (![transport isEqualToString:@"indigo"]) {
    inputError = [NSString stringWithFormat:@"unknown SIMDRIVE_IOS_HID: %@", transport];
    return;
  }
  indigoMouse = (MouseEventFn)dlsym(simKit, "IndigoHIDMessageForMouseNSEvent");
  indigoKeyboard = (KeyboardFn)dlsym(simKit, "IndigoHIDMessageForKeyboardArbitrary");
  Class hidClass = NSClassFromString(@"SimulatorKit.SimDeviceLegacyHIDClient");
  NSError *err = nil;
  if (!indigoMouse || !indigoKeyboard) inputError = @"this Xcode's SimulatorKit has no Indigo HID builders";
  else if (!hidClass) inputError = @"SimDeviceLegacyHIDClient not found in SimulatorKit";
  else if (!(hidClient = [[hidClass alloc] initWithDevice:device error:&err]))
    inputError = [NSString stringWithFormat:@"HID client: %@", err.localizedDescription];
  indigoPending = dispatch_group_create();
}

static void setup(NSString *udid, NSString *developerDir) {
  if (!dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW))
    die(@"CoreSimulator.framework not found — install Xcode");
  NSString *simKit = [developerDir stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"];
  void *sk = dlopen(simKit.fileSystemRepresentation, RTLD_NOW);
  if (!sk) die([NSString stringWithFormat:@"SimulatorKit not found in %@", developerDir]);
  if (!dlopen("/System/Library/PrivateFrameworks/AccessibilityPlatformTranslation.framework/AccessibilityPlatformTranslation", RTLD_NOW))
    die(@"AccessibilityPlatformTranslation.framework not found");

  NSError *err = nil;
  id ctx = [NSClassFromString(@"SimServiceContext") sharedServiceContextForDeveloperDir:developerDir error:&err];
  for (id d in [[ctx defaultDeviceSetWithError:&err] devices])
    if ([[[d UDID] UUIDString] isEqualToString:udid]) device = d;
  if (!device) die([NSString stringWithFormat:@"no simulator %@", udid]);
  if ([device state] != SimDeviceStateBooted) die([NSString stringWithFormat:@"simulator %@ is not booted", udid]);
  screenPx = [[device deviceType] mainScreenSize];
  screenScale = [[device deviceType] mainScreenScale];

  hidQueue = dispatch_queue_create("simdrive.hid", DISPATCH_QUEUE_SERIAL);
  chooseTransport(sk);

  if (![device respondsToSelector:@selector(sendAccessibilityRequestAsync:completionQueue:completionHandler:)])
    die(@"this CoreSimulator has no accessibility bridge");
  bridge = [AXBridge new];
  translator = [NSClassFromString(@"AXPTranslator") sharedInstance];
  [translator setBridgeTokenDelegate:bridge];
  axToken = NSUUID.UUID.UUIDString;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *udid = nil, *socketPath = nil, *developerDir = @"/Applications/Xcode.app/Contents/Developer";
    for (int i = 1; i + 1 < argc; i += 2) {
      NSString *k = @(argv[i]), *v = @(argv[i + 1]);
      if ([k isEqualToString:@"--udid"]) udid = v;
      else if ([k isEqualToString:@"--socket"]) socketPath = v;
      else if ([k isEqualToString:@"--version"]) version = v;
      else if ([k isEqualToString:@"--developer-dir"]) developerDir = v;
    }
    if (!udid || !socketPath) die(@"usage: simdrive-sim --udid <udid> --socket <path> [--version v] [--developer-dir dir]");
    setup(udid, developerDir);

    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    if (socketPath.length >= sizeof(addr.sun_path)) die(@"socket path too long");
    strlcpy(addr.sun_path, socketPath.fileSystemRepresentation, sizeof(addr.sun_path));
    int srv = socket(AF_UNIX, SOCK_STREAM, 0);
    unlink(addr.sun_path);
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) || listen(srv, 8)) die(@"cannot listen on the socket");
    fprintf(stderr, "simdrive-sim %s ready on %s\n", version.UTF8String, socketPath.UTF8String);

    // Exit with the simulator: a helper for a shut-down device is useless and holds its socket.
    dispatch_source_t watch = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(0, 0));
    dispatch_source_set_timer(watch, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC), 5 * NSEC_PER_SEC, NSEC_PER_SEC);
    dispatch_source_set_event_handler(watch, ^{
      if ([device state] != SimDeviceStateBooted) {
        unlink(addr.sun_path);
        exit(0);
      }
    });
    dispatch_resume(watch);

    for (;;) {
      int fd = accept(srv, NULL, NULL);
      if (fd < 0) continue;
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ serve(fd); });
    }
  }
}
