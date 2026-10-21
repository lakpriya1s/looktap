// looktap iOS helper: drives a booted simulator from the host through Apple's simulator frameworks.
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
//          -framework ImageIO -framework CoreGraphics -framework UniformTypeIdentifiers looktap-sim.m

#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMediaIO/CMIOHardware.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ImageIO/ImageIO.h>
#import <IOSurface/IOSurface.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <dlfcn.h>
#import <libproc.h>
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
typedef void *(*ButtonFn)(int32_t, int32_t, int32_t);
static MouseEventFn indigoMouse;
static KeyboardFn indigoKeyboard;
static ButtonFn indigoButton; // optional: only the Home button needs it

static void updateOrientation(id root); // see "orientation" below
static NSRect nativeFrame(id el);

static void die(NSString *msg) {
  fprintf(stderr, "looktap-sim: %s\n", msg.UTF8String);
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
  NSRect f = nativeFrame(el);
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
      NSRect f = nativeFrame(el);
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

static BOOL listed(NSArray *out, NSDictionary *n) {
  for (NSDictionary *m in out)
    if (CGRectEqualToRect(frameOf(m), frameOf(n)) && [m[@"l"] isEqualToString:n[@"l"]]) return YES;
  return NO;
}

/** The pid of the process an accessibility translation object belongs to, or 0. */
static int pidOf(id translation) {
  return [translation respondsToSelector:@selector(pid)] ? [[translation valueForKey:@"pid"] intValue] : 0;
}

/** The element at `p` (system-wide hit test, so it reaches into other processes), or nil. `pid`: its process. */
static NSMutableDictionary *probeAt(CGPoint p, int *pid) {
  probes++;
  id o = [translator objectAtPoint:p displayId:0 bridgeDelegateToken:axToken];
  if (pid) *pid = pidOf(o);
  if (!o) return nil;
  [o setBridgeDelegateToken:axToken];
  id el = [translator macPlatformElementFromTranslation:o];
  [[el translation] setBridgeDelegateToken:axToken];
  NSRect f = nativeFrame(el);
  return f.size.width > 0 && f.size.height > 0 ? row(el, f) : nil;
}

/**
 Content drawn by another process — a web page in Safari or an in-app browser, a sign-in sheet — is
 not in the app's tree at all, not even as an empty container. Hit-testing does reach it. A few probes
 at uncovered points decide whether anything is hidden; only then is the uncovered screen scanned on a
 grid, skipping what each hit covers. Screens the walk fully explains cost a few probes. `appPid`: the
 front app's process, so a hit can tell content drawn by another one.
 */
static void scanForHiddenContent(NSMutableArray *out, CGRect screen, int appPid) {
  double area = screen.size.width * screen.size.height;
  NSMutableArray<NSValue *> *covered = [NSMutableArray array];
  for (NSDictionary *m in out) {
    CGRect f = frameOf(m);
    if (f.size.width * f.size.height < area * 0.5) [covered addObject:[NSValue valueWithRect:f]];
  }
  BOOL (^isCovered)(CGPoint) = ^BOOL(CGPoint p) {
    for (NSValue *c in covered)
      if (CGRectContainsPoint(c.rectValue, p)) return YES;
    return NO;
  };
  // Down the middle: an element the walk missed, smaller than a page (a container hides it from the walk).
  BOOL hidden = NO;
  for (double fy = 0.3; fy < 0.8 && !hidden; fy += 0.2) {
    CGPoint p = CGPointMake(CGRectGetMidX(screen), screen.size.height * fy);
    if (isCovered(p)) continue;
    NSMutableDictionary *n = probeAt(p, NULL);
    if (n && !listed(out, n) && CGRectGetWidth(frameOf(n)) * CGRectGetHeight(frameOf(n)) < area * 0.5) hidden = YES;
  }
  // Then a sparse grid, for a page another process draws: a short web page's content can all sit near the top
  // or to one side, where the line above misses it. Only another process's content counts here, so the app's
  // own unlisted bits (map labels) don't buy every read a full scan.
  for (double fy = 0.1; fy < 1 && !hidden; fy += 0.2) {
    for (double fx = 1 / 6.0; fx < 1 && !hidden; fx += 1 / 3.0) {
      CGPoint p = CGPointMake(screen.size.width * fx, screen.size.height * fy);
      if (isCovered(p)) continue;
      int pid = 0;
      NSMutableDictionary *n = probeAt(p, &pid);
      BOOL small = n && CGRectGetWidth(frameOf(n)) * CGRectGetHeight(frameOf(n)) < area * 0.5; // not a page-sized surface
      if (small && !listed(out, n) && appPid && pid && pid != appPid) hidden = YES;
    }
  }
  if (!hidden) return;
  const double step = 40;
  for (double y = step / 2; y < screen.size.height; y += step) {
    for (double x = step / 2; x < screen.size.width; x += step) {
      CGPoint p = CGPointMake(x, y);
      if (isCovered(p)) continue;
      NSMutableDictionary *n = probeAt(p, NULL);
      CGRect f = n ? frameOf(n) : CGRectZero;
      // The probed cell is explained whatever comes back: hit-testing snaps a blank point to the
      // nearest element, which needn't contain it. A real element (not a page-sized container)
      // also explains its own frame.
      [covered addObject:[NSValue valueWithRect:CGRectMake(x - step / 2, y - step / 2, step, step)]];
      BOOL container = !n || f.size.width * f.size.height >= area * 0.5;
      if (container) continue;
      [covered addObject:[NSValue valueWithRect:f]];
      if (!listed(out, n)) [out addObject:n];
    }
  }
}

static NSArray *readTree(BOOL all) {
  id app = [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:axToken];
  // No frontmost app can mean a system-hosted sheet (a sign-in session) is on top: still scan for it.
  [app setBridgeDelegateToken:axToken];
  id root = app ? [translator macPlatformElementFromTranslation:app] : nil;
  NSMutableArray *out = [NSMutableArray array], *holes = [NSMutableArray array];
  CGRect screen = CGRectMake(0, 0, screenPx.width / screenScale, screenPx.height / screenScale);
  probes = 0;
  updateOrientation(root);
  if (root) walk(root, out, holes, all, screen);
  for (NSValue *h in holes) {
    fillHole(h.rectValue, out);
  }
  scanForHiddenContent(out, screen, app ? pidOf(app) : 0);
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
    // UIKeyboardLayout… is on every layout (letters, number pad); the key ids are a fallback.
    if ([ident hasPrefix:@"UIKeyboardLayout"] || [ident isEqualToString:@"delete"] || [ident isEqualToString:@"space"] ||
        [ident isEqualToString:@"shift"])
      return YES;
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
// Both expose the same primitives: touch start/move/end, key down/up, the Home button, and sync (wait
// until delivered).

typedef enum { TouchStart = 0, TouchMove = 1, TouchEnd = 2 } TouchPhase; // = dtuhidd's eventType

static NSString *transport;     // "indigo" | "dtuhid"
static NSString *inputError;    // set when input cannot work; reported by every input op

// ── orientation ──
//
// Rotated, the accessibility frames, hit-testing, the digitizer and the framebuffer all stay in the
// device's native portrait space; only the Application element's frame turns. Clients get the screen as
// the user sees it: tree frames are converted out of native space, touches into it, frames are turned.
// Values are UIDeviceOrientation: 1 portrait, 2 upside down, 3 landscape left (turned counter-clockwise,
// the interface's top at the native right edge), 4 landscape right.

static int uiOrientation = 1;   // how the interface is turned, as of the last look
static int lastLandscape = 3;   // which landscape side an app forced into landscape was last seen on
static BOOL isPad;

static double nativeW(void) { return screenPx.width / screenScale; }
static double nativeH(void) { return screenPx.height / screenScale; }
static BOOL sideways(void) { return uiOrientation == 3 || uiOrientation == 4; }

/** The device's orientation as the guest's backboardd last published it (0 when unknown). */
static int deviceOrientation(void) {
  uint64_t state = 0;
  SEL get = NSSelectorFromString(@"darwinNotificationGetState:name:error:");
  if (![device respondsToSelector:get]) return 0;
  BOOL ok = ((BOOL(*)(id, SEL, uint64_t *, NSString *, NSError **))objc_msgSend)(device, get, &state, @"com.apple.backboardd.orientation", NULL);
  return ok ? (int)state : 0;
}

/**
 The interface's orientation, from the device's and the front app's shape: a landscape-shaped app sits on
 the side the device is turned to. An upright device leaves the interface upright, except an iPad held
 upside down. Face up/down (5, 6) keep the last one.
 */
static void updateOrientation(id root) {
  int device = deviceOrientation();
  if (device == 5 || device == 6) return;
  NSRect f = root ? [root accessibilityFrame] : NSZeroRect;
  BOOL wide = f.size.width > f.size.height;
  if (!root) wide = isPad && (device == 3 || device == 4); // the iPhone home screen never turns
  if (wide) uiOrientation = lastLandscape = (device == 3 || device == 4) ? device : lastLandscape;
  else uiOrientation = isPad && device == 2 ? 2 : 1;
}

static void lookAtOrientation(void) {
  id app = [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:axToken];
  [app setBridgeDelegateToken:axToken];
  updateOrientation(app ? [translator macPlatformElementFromTranslation:app] : nil);
}

/** A point on the screen as the user sees it → native portrait points. */
static CGPoint toNative(double x, double y) {
  switch (uiOrientation) {
    case 2: return CGPointMake(nativeW() - x, nativeH() - y);
    case 3: return CGPointMake(nativeW() - y, x);
    case 4: return CGPointMake(y, nativeH() - x);
    default: return CGPointMake(x, y);
  }
}

/** A native frame → the same frame on the screen as the user sees it. */
static CGRect fromNative(CGRect r) {
  double x = r.origin.x, y = r.origin.y, w = r.size.width, h = r.size.height;
  switch (uiOrientation) {
    case 2: return CGRectMake(nativeW() - x - w, nativeH() - y - h, w, h);
    case 3: return CGRectMake(y, nativeW() - x - w, h, w);
    case 4: return CGRectMake(nativeH() - y - h, x, h, w);
    default: return r;
  }
}

/** A frame on the screen as the user sees it → native. */
static CGRect toNativeRect(CGRect r) {
  double x = r.origin.x, y = r.origin.y, w = r.size.width, h = r.size.height;
  switch (uiOrientation) {
    case 2: return CGRectMake(nativeW() - x - w, nativeH() - y - h, w, h);
    case 3: return CGRectMake(nativeW() - y - h, x, h, w);
    case 4: return CGRectMake(y, nativeH() - x - w, h, w);
    default: return r;
  }
}

/**
 Whether a process lays itself out in native space while the screen is turned. A frame comes in its owner's
 own space: an app that turned reports turned frames, but SpringBoard never turns on an iPhone, so the
 alerts it shows over a turned app come in native space.
 */
static BOOL staysNative(int pid) {
  static NSMutableDictionary<NSNumber *, NSNumber *> *known;
  if (!known) known = [NSMutableDictionary dictionary];
  NSNumber *k = @(pid), *v = known[k];
  if (!v) {
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (pid > 0) proc_pidpath(pid, path, sizeof path);
    known[k] = v = @(!isPad && strstr(path, "/SpringBoard.app/") != NULL);
  }
  return v.boolValue;
}

/** An element's frame in native space, the one hit-testing and the digitizer use (see "orientation"). */
static NSRect nativeFrame(id el) {
  NSRect f = [el accessibilityFrame];
  if (uiOrientation == 1 || [str([el accessibilityRole]) isEqualToString:@"AXApplication"]) return f;
  id t = [el translation];
  int pid = [t respondsToSelector:@selector(pid)] ? [[t valueForKey:@"pid"] intValue] : 0;
  return staysNative(pid) ? f : NSRectFromCGRect(toNativeRect(NSRectToCGRect(f)));
}

/** The screen as the user sees it, in points. */
static CGSize viewSize(void) {
  return sideways() ? CGSizeMake(nativeH(), nativeW()) : CGSizeMake(nativeW(), nativeH());
}

/** A touch in on-screen points → the digitizer's normalized native coordinates. */
static CGPoint ratioFor(double x, double y) {
  CGPoint p = toNative(x, y);
  return CGPointMake(p.x * screenScale / screenPx.width, p.y * screenScale / screenPx.height);
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

/**
 Two fingers. Passing a second point makes SimulatorKit build a three-payload multi-touch message:
 finger 1, a digitizer summary mirroring it, finger 2 (wire offsets 0x20, 0xC0, 0x160; idb's layout).
 Every contact's ratios are set explicitly rather than trusting the builder's normalisation.
 */
static void *twoFingerMessage(double x1, double y1, double x2, double y2, BOOL down) {
  CGPoint r1 = ratioFor(x1, y1), r2 = ratioFor(x2, y2);
  char *m = indigoMouse(&r1, &r2, 0x32, down ? 1 : 2, CGSizeMake(1, 1), 0);
  const int at[3] = {0x20, 0xC0, 0x160};
  const CGPoint r[3] = {r1, r1, r2};
  for (int i = 0; i < 3; i++) {
    *(double *)(m + at[i] + 0x1c) = r[i].x; // payload.event.touch.xRatio
    *(double *)(m + at[i] + 0x24) = r[i].y; // payload.event.touch.yRatio
  }
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

/** IndigoButtonEvent: a hardware button as a consumer-page usage (Home is 0x0C/0x40, Menu), state 1 down, 2 up. */
static xpc_object_t dtuButtonMessage(int page, int usage, BOOL down) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_uint64(p, "usagePage", (uint64_t)page);
  xpc_dictionary_set_uint64(p, "usageCode", (uint64_t)usage);
  xpc_dictionary_set_uint64(p, "state", down ? 1 : 2);
  return dtuMessage("IndigoButtonEvent", p, NO);
}

static xpc_object_t dtuPoint(double x, double y) {
  CGPoint r = ratioFor(x, y);
  xpc_object_t pt = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(pt, "x", r.x);
  xpc_dictionary_set_double(pt, "y", r.y);
  return pt;
}

/**
 IndigoDigitizerEvent: one contact (pointOne), or two (+ pointTwo, x2 ≥ 0), in normalized top-left
 coordinates; eventType start/position/end.
 */
static xpc_object_t dtuTouchMessage(TouchPhase phase, double x, double y, double x2, double y2) {
  xpc_object_t p = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(p, "pointOne", dtuPoint(x, y));
  if (x2 >= 0) xpc_dictionary_set_value(p, "pointTwo", dtuPoint(x2, y2));
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
  if (dtuConnection) xpc_connection_send_message(dtuConnection, dtuTouchMessage(phase, x, y, -1, -1));
  else indigoSend(touchMessage(x, y, phase != TouchEnd));
}

static void touch2(TouchPhase phase, double x1, double y1, double x2, double y2) {
  requireInput();
  if (dtuConnection) xpc_connection_send_message(dtuConnection, dtuTouchMessage(phase, x1, y1, x2, y2));
  else indigoSend(twoFingerMessage(x1, y1, x2, y2, phase != TouchEnd));
}

static void keyEvent(int usage, BOOL down) {
  requireInput();
  if (dtuConnection) xpc_connection_send_message(dtuConnection, dtuKeyMessage(usage, down, NO));
  else indigoSend(indigoKeyboard(usage, down ? 1 : 2));
}

// Indigo.h: ButtonEventSourceHomeButton 0x0, ButtonEventTargetHardware 0x33; direction 1 down, 2 up.
enum { BUTTON_HOME = 0x0, BUTTON_TARGET_HARDWARE = 0x33 };

static void homeEvent(BOOL down) {
  requireInput();
  if (dtuConnection) xpc_connection_send_message(dtuConnection, dtuButtonMessage(0x0C, 0x40, down));
  else if (indigoButton) indigoSend(indigoButton(BUTTON_HOME, down ? 1 : 2, BUTTON_TARGET_HARDWARE));
  else [NSException raise:@"hid" format:@"this Xcode's SimulatorKit has no IndigoHIDMessageForButton"];
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

/** One press of the Home button (the gesture's equivalent on Face ID devices): to the home screen. */
static void home(void) {
  homeEvent(YES);
  hidSync();
  usleep(50000);
  homeEvent(NO);
  hidSync();
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

/**
 Two fingers on a horizontal line through (cx, cy), from `r0` to `r1` points either side of it: r1 > r0
 spreads them (zoom in), r1 < r0 brings them together (zoom out). idb's pinch: a contact every ~10
 points of travel, the last one repeated before lifting (no inertia).
 */
static void pinch(double cx, double cy, double r0, double r1, int ms) {
  int steps = MAX(2, (int)(fabs(r1 - r0) / 10));
  useconds_t gap = (useconds_t)(ms * 1000.0 / (steps + 2));
  touch2(TouchStart, cx - r0, cy, cx + r0, cy);
  for (int i = 1; i <= steps; i++) {
    usleep(gap);
    double r = r0 + (r1 - r0) * i / steps;
    touch2(TouchMove, cx - r, cy, cx + r, cy);
  }
  usleep(gap);
  touch2(TouchMove, cx - r1, cy, cx + r1, cy);
  touch2(TouchEnd, cx - r1, cy, cx + r1, cy);
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

/** Named keys, or a raw HID usage number. "selectall" is Cmd-A, "paste" Cmd-V, "home" the Home button. */
static void key(NSString *name) {
  NSDictionary *named = @{
    @"return" : @(KEY_ENTER), @"enter" : @(KEY_ENTER), @"escape" : @(KEY_ESCAPE), @"delete" : @(KEY_BACKSPACE),
    @"backspace" : @(KEY_BACKSPACE), @"tab" : @(KEY_TAB), @"space" : @(KEY_SPACE),
  };
  NSString *k = name.lowercaseString;
  if ([k isEqualToString:@"selectall"]) return press(4, @[ @(KEY_CMD) ]);
  if ([k isEqualToString:@"paste"]) return press(25, @[ @(KEY_CMD) ]);
  if ([k isEqualToString:@"home"]) return home();
  NSNumber *u = named[k];
  if (!u && k.integerValue > 0) u = @(k.integerValue);
  if (!u) [NSException raise:@"key" format:@"unknown key: %@", name];
  press(u.intValue, @[]);
}

// ── rotation ─────────────────────────────────────────────────────────────
//
// What Simulator.app's Rotate Left/Right does: a GraphicsServices event on the guest's PurpleWorkspacePort.
// Wire format: facebook/idb PrivateHeaders/SimulatorApp/GSEvent.h.

enum { GSEventDeviceOrientationChanged = 50, GSEventHostFlag = 0x20000, GSEventMachMessageID = 0x7B };

/** Device orientation (UIDeviceOrientation: 1 portrait, 2 upside down, 3 landscape left, 4 landscape right). */
static void sendOrientation(uint32_t orientation) {
  NSError *err = nil;
  mach_port_t port = [device lookup:@"PurpleWorkspacePort" error:&err];
  if (port == MACH_PORT_NULL) [NSException raise:@"rotate" format:@"no PurpleWorkspacePort: %@", err.localizedDescription ?: @"lookup failed"];
  uint8_t m[0x6C] = {0}; // align4(record_info_size 4 + 0x6B)
  mach_msg_header_t *h = (mach_msg_header_t *)m;
  h->msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0);
  h->msgh_size = sizeof m;
  h->msgh_remote_port = port;
  h->msgh_id = GSEventMachMessageID;
  *(uint32_t *)(m + 0x18) = GSEventDeviceOrientationChanged | GSEventHostFlag;
  *(uint32_t *)(m + 0x48) = 4; // record_info_size
  *(uint32_t *)(m + 0x4C) = orientation;
  kern_return_t kr = mach_msg(h, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof m, 0, MACH_PORT_NULL, 2000, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) [NSException raise:@"rotate" format:@"orientation event not delivered (mach_msg %d)", kr];
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

/**
 Screen updates, for `perf --frames`. The framebuffer's seed moves each time the simulator draws the screen, so a
 timer on its own queue notes when it moves, every 2 ms, while other ops run. The first call starts it; each later
 call returns the update times since the previous one, and starts over. Nobody asking for 10 minutes stops it.
 */
static dispatch_queue_t frameQueue;
static dispatch_source_t frameTimer;
static IOSurfaceRef frameSurface;
static uint32_t frameSeed;
static NSMutableData *frameTimes; // doubles: ms since frameStart
static double frameStart, frameAsked;
static uint64_t seedSteps;

static double uptimeMs(void) {
  return clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1e6;
}

static NSDictionary *frames(void) {
  if (!frameQueue) frameQueue = dispatch_queue_create("looktap.frames", DISPATCH_QUEUE_SERIAL);
  IOSurfaceRef s = mainSurface();
  if (!s) return @{@"ok" : @NO, @"error" : @"no framebuffer for the main display"};
  __block NSDictionary *out;
  dispatch_sync(frameQueue, ^{
    double now = uptimeMs();
    if (frameSurface != s) { // first call, or the display's surface was replaced
      if (frameSurface) CFRelease(frameSurface);
      frameSurface = (IOSurfaceRef)CFRetain(s);
      frameSeed = IOSurfaceGetSeed(frameSurface);
    }
    if (!frameTimer) {
      frameTimes = [NSMutableData data];
      frameStart = frameAsked = now;
      seedSteps = 0;
      frameSeed = IOSurfaceGetSeed(frameSurface);
      frameTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, DISPATCH_TIMER_STRICT, frameQueue);
      dispatch_source_set_timer(frameTimer, DISPATCH_TIME_NOW, 2 * NSEC_PER_MSEC, 200 * NSEC_PER_USEC);
      dispatch_source_set_event_handler(frameTimer, ^{
        double t = uptimeMs();
        if (t - frameAsked > 600000) {
          dispatch_source_cancel(frameTimer);
          frameTimer = nil;
          return;
        }
        uint32_t seed = IOSurfaceGetSeed(frameSurface);
        if (seed == frameSeed) return;
        seedSteps += (uint32_t)(seed - frameSeed);
        frameSeed = seed;
        double at = t - frameStart;
        if (frameTimes.length < 200000 * sizeof(double)) [frameTimes appendBytes:&at length:sizeof at];
      });
      dispatch_resume(frameTimer);
      out = @{@"ok" : @YES, @"started" : @YES};
      return;
    }
    NSUInteger n = frameTimes.length / sizeof(double);
    const double *t = frameTimes.bytes;
    NSMutableArray *times = [NSMutableArray arrayWithCapacity:n];
    for (NSUInteger i = 0; i < n; i++) [times addObject:@(round(t[i] * 10) / 10)];
    out = @{@"ok" : @YES, @"ms" : @(round(now - frameStart)), @"times" : times, @"seedSteps" : @(seedSteps)};
    frameTimes = [NSMutableData data];
    frameStart = frameAsked = now;
    seedSteps = 0;
  });
  return out;
}

/** The surface as PNG, upright as the user sees it (see "orientation"), shrunk by `scale` when 0 < scale < 1. */
static NSData *png(IOSurfaceRef s, double scale) {
  IOSurfaceLock(s, kIOSurfaceLockReadOnly, NULL);
  size_t w = IOSurfaceGetWidth(s), h = IOSurfaceGetHeight(s), stride = IOSurfaceGetBytesPerRow(s);
  CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGDataProviderRef dp = CGDataProviderCreateWithData(NULL, IOSurfaceGetBaseAddress(s), stride * h, NULL);
  CGImageRef img = CGImageCreate(w, h, 8, 32, stride, cs, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst, dp, NULL, NO,
                                 kCGRenderingIntentDefault);
  if (!(scale > 0 && scale < 1)) scale = 1;
  if (scale < 1 || uiOrientation != 1) {
    size_t sw = MAX(1, (size_t)round(w * scale)), sh = MAX(1, (size_t)round(h * scale));
    size_t ow = sideways() ? sh : sw, oh = sideways() ? sw : sh;
    CGContextRef ctx = CGBitmapContextCreate(NULL, ow, oh, 8, 0, cs, kCGBitmapByteOrder32Little | kCGImageAlphaNoneSkipFirst);
    CGContextSetInterpolationQuality(ctx, kCGInterpolationHigh);
    // Turn the native image so the interface's top is up: 3 has it at the right edge (a quarter turn
    // counter-clockwise), 4 at the left (clockwise), 2 at the bottom.
    if (uiOrientation == 3) CGContextTranslateCTM(ctx, ow, 0), CGContextRotateCTM(ctx, M_PI_2);
    else if (uiOrientation == 4) CGContextTranslateCTM(ctx, 0, oh), CGContextRotateCTM(ctx, -M_PI_2);
    else if (uiOrientation == 2) CGContextTranslateCTM(ctx, ow, oh), CGContextRotateCTM(ctx, M_PI);
    CGContextDrawImage(ctx, CGRectMake(0, 0, sw, sh), img);
    CGImageRelease(img);
    img = CGBitmapContextCreateImage(ctx);
    CGContextRelease(ctx);
  }
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
      reply(fd, @{@"frame" : @(++sent), @"ms" : @(round(-end.timeIntervalSinceNow * 1000))}, png(s, 1));
    }
    usleep(16000);
  }
  reply(fd, @{@"ok" : @YES, @"done" : @YES, @"frames" : @(frames), @"distinct" : @(sent)}, nil);
}

/** The screen as the user sees it: points, and which way it is turned (UIDeviceOrientation). */
static NSDictionary *screenInfo(void) {
  CGSize v = viewSize();
  return @{@"w" : @(round(v.width)), @"h" : @(round(v.height)), @"orientation" : @(uiOrientation)};
}

static void handle(int fd, NSDictionary *r) {
  NSString *op = r[@"op"];
  if ([op isEqualToString:@"hello"]) return reply(fd, @{
    @"ok" : @YES, @"version" : version, @"pid" : @(getpid()), @"input" : transport ?: @"",
    @"coreSimulator" : coreSimulatorVersion() ?: @"", @"inputError" : inputError ?: @""
  }, nil);
  if ([op isEqualToString:@"tree"]) {
    NSArray *nodes = tree([r[@"all"] boolValue], ![r[@"settle"] isEqual:@NO]);
    // Frames leave native space here; the Application's own frame is already the turned one.
    if (uiOrientation != 1 && ![r[@"raw"] boolValue])
      for (NSMutableDictionary *n in nodes) {
        if ([n[@"t"] isEqualToString:@"Application"]) continue;
        CGRect f = fromNative(frameOf(n));
        n[@"x"] = @(round(f.origin.x)), n[@"y"] = @(round(f.origin.y)), n[@"w"] = @(round(f.size.width)), n[@"h"] = @(round(f.size.height));
      }
    return reply(fd, @{@"ok" : @YES, @"nodes" : nodes, @"probes" : @(probes), @"screen" : screenInfo()}, nil);
  }
  // Touches are given in on-screen points: know which way the screen is turned before converting them.
  if ([@[ @"tap", @"pinch", @"swipe", @"shot", @"burst" ] containsObject:op]) lookAtOrientation();
  if ([op isEqualToString:@"tap"]) {
    tap(num(r, @"x", 0), num(r, @"y", 0), (int)num(r, @"hold", 50));
    return reply(fd, @{@"ok" : @YES}, nil);
  }
  if ([op isEqualToString:@"pinch"]) {
    pinch(num(r, @"x", 0), num(r, @"y", 0), num(r, @"r0", 40), num(r, @"r1", 100), (int)num(r, @"ms", 400));
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
  if ([op isEqualToString:@"home"]) {
    home();
    return reply(fd, @{@"ok" : @YES}, nil);
  }
  if ([op isEqualToString:@"front"]) {
    // The frontmost app's pid (0 when none, e.g. the home screen): the CLI maps it to a bundle id.
    id app = [translator frontmostApplicationWithDisplayId:0 bridgeDelegateToken:axToken];
    int pid = [app respondsToSelector:@selector(pid)] ? [[app valueForKey:@"pid"] intValue] : 0;
    // Simulator apps are host processes: their executable path names the .app (and so the bundle id).
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (pid > 0) proc_pidpath(pid, path, sizeof path);
    return reply(fd, @{@"ok" : @YES, @"pid" : @(pid), @"path" : @(path)}, nil);
  }
  if ([op isEqualToString:@"rotate"]) {
    int want = (int)num(r, @"orientation", 0);
    if (want >= 1 && want <= 4) {
      sendOrientation((uint32_t)want);
      // backboardd publishes the new orientation at once; the interface turns over ~0.4 s after it.
      for (int i = 0; i < 20 && deviceOrientation() != want; i++) usleep(50000);
      usleep(400000);
      // Then until the interface holds one orientation for three looks in a row: mid-turn, an app can
      // report a frame it then leaves (one presenting a menu may turn back).
      int last = 0, same = 0;
      for (int i = 0; i < 25 && same < 3; i++, usleep(120000)) {
        lookAtOrientation();
        same = uiOrientation == last ? same + 1 : 1;
        last = uiOrientation;
      }
    }
    lookAtOrientation();
    return reply(fd, @{@"ok" : @YES, @"device" : @(deviceOrientation()), @"screen" : screenInfo()}, nil);
  }
  if ([op isEqualToString:@"keyboard"]) return reply(fd, @{@"ok" : @YES, @"shown" : @(keyboardShown())}, nil);
  if ([op isEqualToString:@"shot"]) {
    IOSurfaceRef s = mainSurface();
    if (!s) return reply(fd, @{@"ok" : @NO, @"error" : @"no framebuffer for the main display"}, nil);
    return reply(fd, @{@"ok" : @YES}, png(s, num(r, @"scale", 1)));
  }
  if ([op isEqualToString:@"burst"]) return burst(fd, num(r, @"seconds", 5));
  if ([op isEqualToString:@"frames"]) return reply(fd, frames(), nil);
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
  dispatch_once(&once, ^{ work = dispatch_queue_create("looktap.work", DISPATCH_QUEUE_SERIAL); });
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
 not, so it has to be dtuhidd — idb's rule. LOOKTAP_IOS_HID=indigo|dtuhid overrides it.
 Input problems are recorded in `inputError`, not fatal: reading the screen still works.
 */
static void chooseTransport(void *simKit) {
  const char *forced = getenv("LOOKTAP_IOS_HID");
  NSString *v = coreSimulatorVersion();
  BOOL modern = v && [v compare:@"1155.4" options:NSNumericSearch] != NSOrderedAscending;
  transport = forced && *forced ? @(forced) : modern ? @"dtuhid" : @"indigo";
  if ([transport isEqualToString:@"dtuhid"]) return; // connected on first input (dtuhidd is demand-launched)
  if (![transport isEqualToString:@"indigo"]) {
    inputError = [NSString stringWithFormat:@"unknown LOOKTAP_IOS_HID: %@", transport];
    return;
  }
  if (!simKit) {
    inputError = @"SimulatorKit not found in this Xcode (indigo input needs it)";
    return;
  }
  indigoMouse = (MouseEventFn)dlsym(simKit, "IndigoHIDMessageForMouseNSEvent");
  indigoKeyboard = (KeyboardFn)dlsym(simKit, "IndigoHIDMessageForKeyboardArbitrary");
  indigoButton = (ButtonFn)dlsym(simKit, "IndigoHIDMessageForButton");
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
  // SimulatorKit is in Developer/Library/PrivateFrameworks up to Xcode 26, and in Contents/SharedFrameworks from
  // Xcode 27.1. Only the indigo transport needs it, so a missing one is an input error there, not a failed start.
  void *sk = NULL;
  for (NSString *dir in @[@"Library/PrivateFrameworks", @"../SharedFrameworks"]) {
    NSString *path = [[developerDir stringByAppendingPathComponent:dir] stringByAppendingPathComponent:@"SimulatorKit.framework/SimulatorKit"];
    if ((sk = dlopen(path.stringByStandardizingPath.fileSystemRepresentation, RTLD_NOW))) break;
  }
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
  isPad = [str([[device deviceType] valueForKey:@"name"]) hasPrefix:@"iPad"];

  hidQueue = dispatch_queue_create("looktap.hid", DISPATCH_QUEUE_SERIAL);
  chooseTransport(sk);

  if (![device respondsToSelector:@selector(sendAccessibilityRequestAsync:completionQueue:completionHandler:)])
    die(@"this CoreSimulator has no accessibility bridge");
  bridge = [AXBridge new];
  translator = [NSClassFromString(@"AXPTranslator") sharedInstance];
  [translator setBridgeTokenDelegate:bridge];
  axToken = NSUUID.UUID.UUIDString;
}

// ---- `--capture`: a real iPhone's screen over USB, for `perf --frames` -------------------------------------------
//
// The capture device QuickTime uses ("iOS Device"). It delivers frames at up to 60 per second whether the screen
// changes or not, and it's lossy video, so each frame is compared with the one before: the brightness of every
// 8th pixel each way, below the status bar; a frame where 64 or more of those moved by more than 24 levels is new
// content (still frames move 0–1, a scroll thousands). One line per delivered frame: "<ms> <0|1>", ms on the
// frame's presentation clock. It stops when nobody has touched `--asked` for 10 minutes, or the phone goes away.

@interface FeedReader : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@property(nonatomic) FILE *log;
@end

@implementation FeedReader {
  NSMutableData *_prev;
  double _t0;
}
- (void)captureOutput:(AVCaptureOutput *)output didOutputSampleBuffer:(CMSampleBufferRef)buffer fromConnection:(AVCaptureConnection *)connection {
  double pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer)) * 1000;
  if (_t0 == 0) _t0 = pts;
  CVPixelBufferRef px = CMSampleBufferGetImageBuffer(buffer);
  if (!px) return;
  CVPixelBufferLockBaseAddress(px, kCVPixelBufferLock_ReadOnly);
  // The feed's own format (4:2:0 YUV): the brightness plane, read in place. Asking for BGRA instead converts every
  // full-size frame, and the capture then drops frames during motion.
  size_t w = CVPixelBufferGetWidthOfPlane(px, 0), h = CVPixelBufferGetHeightOfPlane(px, 0), row = CVPixelBufferGetBytesPerRowOfPlane(px, 0);
  const uint8_t *base = CVPixelBufferGetBaseAddressOfPlane(px, 0);
  NSMutableData *cur = [NSMutableData dataWithCapacity:(w / 8 + 1) * (h / 8 + 1)];
  for (size_t y = h * 6 / 100; y < h; y += 8)
    for (size_t x = 0; x < w; x += 8) [cur appendBytes:base + y * row + x length:1];
  CVPixelBufferUnlockBaseAddress(px, kCVPixelBufferLock_ReadOnly);
  int moved = 0;
  if (_prev.length == cur.length) {
    const uint8_t *a = _prev.bytes, *b = cur.bytes;
    for (NSUInteger i = 0; i < cur.length && moved < 64; i++) moved += abs((int)a[i] - (int)b[i]) > 24;
  }
  BOOL changed = _prev == nil || moved >= 64;
  _prev = cur;
  fprintf(self.log, "%.1f %d\n", pts - _t0, changed);
  fflush(self.log);
}
@end

static int capture(NSString *name, NSString *logPath, NSString *askedPath) {
  CMIOObjectPropertyAddress prop = {kCMIOHardwarePropertyAllowScreenCaptureDevices, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
  UInt32 allow = 1;
  CMIOObjectSetPropertyData(kCMIOObjectSystemObject, &prop, 0, NULL, sizeof allow, &allow);
  FILE *log = fopen(logPath.fileSystemRepresentation, "a");
  if (!log) die(@"cannot write the frames log");
  AVCaptureDevice *device = nil;
  // It shows up a moment after screen capture is allowed, and only once an earlier capture (QuickTime, or a stopped
  // one) has let go of it, which can take several seconds.
  for (int i = 0; i < 40 && !device; i++) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    AVCaptureDeviceType external = AVCaptureDeviceTypeExternalUnknown; // macOS 12–13's name for it
#pragma clang diagnostic pop
    if (@available(macOS 14.0, *)) external = AVCaptureDeviceTypeExternal;
    NSArray *all = [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[ external ] mediaType:AVMediaTypeMuxed
                                                                            position:AVCaptureDevicePositionUnspecified].devices;
    for (AVCaptureDevice *d in all)
      if ([d.modelID isEqualToString:@"iOS Device"] && (!name.length || [d.localizedName isEqualToString:name] || all.count == 1)) device = d;
    if (!device) [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.5]];
  }
  if (!device) {
    fprintf(log, "error no screen capture device for %s: connect it with a USB cable and unlock it\n", name.UTF8String);
    return 1;
  }
  NSError *error = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
  AVCaptureSession *session = [AVCaptureSession new];
  if (!input || ![session canAddInput:input]) {
    fprintf(log, "error %s\n", (error.localizedDescription ?: @"the screen capture device is busy (QuickTime?)").UTF8String);
    return 1;
  }
  [session addInput:input];
  AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
  output.videoSettings = @{(id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)};
  output.alwaysDiscardsLateVideoFrames = NO;
  FeedReader *reader = [FeedReader new];
  reader.log = log;
  [output setSampleBufferDelegate:reader queue:dispatch_queue_create("looktap.feed", DISPATCH_QUEUE_SERIAL)];
  [session addOutput:output];
  [session startRunning];
  fprintf(log, "started %.0f\n", NSDate.date.timeIntervalSince1970 * 1000);
  fflush(log);
  for (;;) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:5]];
    NSDate *asked = [NSFileManager.defaultManager attributesOfItemAtPath:askedPath error:nil].fileModificationDate;
    if (!session.isRunning || !device.isConnected || !asked || asked.timeIntervalSinceNow < -600) break;
  }
  [session stopRunning];
  fprintf(log, "stopped\n");
  return 0;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    if (argc > 1 && !strcmp(argv[1], "--capture")) {
      NSString *name = argc > 2 ? @(argv[2]) : @"", *logPath = argc > 3 ? @(argv[3]) : nil, *asked = argc > 4 ? @(argv[4]) : nil;
      if (!logPath || !asked) die(@"usage: looktap-sim --capture <device name> <log> <asked-file>");
      return capture(name, logPath, asked);
    }
    NSString *udid = nil, *socketPath = nil, *developerDir = @"/Applications/Xcode.app/Contents/Developer";
    for (int i = 1; i + 1 < argc; i += 2) {
      NSString *k = @(argv[i]), *v = @(argv[i + 1]);
      if ([k isEqualToString:@"--udid"]) udid = v;
      else if ([k isEqualToString:@"--socket"]) socketPath = v;
      else if ([k isEqualToString:@"--version"]) version = v;
      else if ([k isEqualToString:@"--developer-dir"]) developerDir = v;
    }
    if (!udid || !socketPath) die(@"usage: looktap-sim --udid <udid> --socket <path> [--version v] [--developer-dir dir]");
    setup(udid, developerDir);

    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    if (socketPath.length >= sizeof(addr.sun_path)) die(@"socket path too long");
    strlcpy(addr.sun_path, socketPath.fileSystemRepresentation, sizeof(addr.sun_path));
    int srv = socket(AF_UNIX, SOCK_STREAM, 0);
    unlink(addr.sun_path);
    if (bind(srv, (struct sockaddr *)&addr, sizeof(addr)) || listen(srv, 8)) die(@"cannot listen on the socket");
    fprintf(stderr, "looktap-sim %s ready on %s\n", version.UTF8String, socketPath.UTF8String);

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
