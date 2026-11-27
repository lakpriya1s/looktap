// looktap touches for iOS: draws a pointer where each touch lands, inside the app that receives it.
//
// Two ways in:
//  - iOS simulator: `looktap touches on` loads this into apps as a dylib (lib/assets/looktap-touches.dylib). Nothing
//    to add to your app.
//  - A real iPhone: iOS loads nothing into an app from outside, so add this one file to your app target (Debug
//    builds only). It draws nothing until looktap asks: `looktap touches on`, then `looktap launch`, which passes
//    LOOKTAP_TOUCHES=1. The launch argument `-LooktapTouches YES` switches it on too.
//
// How: -[UIApplication sendEvent:] is wrapped, and each touch gets a small layer on top of the window it's in. No
// window and no view is added, so the app's own hit-testing and accessibility tree (what `looktap ls` reads) don't
// change.
//
// Every UIKit and QuartzCore class is looked up by name at run time. As a dylib this file links Foundation only: a
// simulator-wide insert reaches processes that never load UIKit, and there it must do nothing at all.
#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <notify.h>
#import <objc/runtime.h>

#define LT_CLASS(name) ((Class)objc_getClass(#name))

static const CGFloat kRadius = 20;        // the pointer, in points
static const CGFloat kTrailRadius = 7;    // the dots a moving finger leaves behind
static const CGFloat kTrailStep = 10;     // points moved between two trail dots
static const CFTimeInterval kFade = 0.4;  // how long a lifted finger stays visible: a quick tap is over in 50 ms

static BOOL gOn;
static NSMapTable *gDots;    // UITouch → its pointer layer
static NSMapTable *gTrails;  // UITouch → where its last trail dot went (an NSValue)
static IMP gSendEvent;

static CGColorRef LTColor(CGFloat white, CGFloat alpha) {
  return [(UIColor *)[LT_CLASS(UIColor) colorWithWhite:white alpha:alpha] CGColor];
}

/// looktap's accent (the site's --accent, #22d3ee): the pointer, and the glow around the screen's edge.
static CGColorRef LTAccent(CGFloat alpha) {
  return [(UIColor *)[LT_CLASS(UIColor) colorWithRed:0x22 / 255.0 green:0xd3 / 255.0 blue:0xee / 255.0 alpha:alpha] CGColor];
}

static CALayer *LTDisc(CGPoint at, CGFloat radius) {
  CALayer *l = [LT_CLASS(CALayer) layer];
  l.bounds = CGRectMake(0, 0, radius * 2, radius * 2);
  l.position = at;
  l.cornerRadius = radius;
  // The accent inside and as its ring, with a soft dark halo so it shows on a light screen too.
  l.backgroundColor = LTAccent(0.35);
  l.borderColor = LTAccent(0.95);
  l.borderWidth = radius > 10 ? 2.5 : 1.5;
  l.shadowOpacity = 0.45;
  l.shadowRadius = 3;
  l.shadowOffset = CGSizeMake(0, 0);
  l.zPosition = 1e9;
  return l;
}

static CABasicAnimation *LTAnim(NSString *key, id from, id to, CFTimeInterval duration) {
  CABasicAnimation *a = [LT_CLASS(CABasicAnimation) animationWithKeyPath:key];
  a.fromValue = from;
  a.toValue = to;
  a.duration = duration;
  return a;
}

/// Fade `layer` out (growing to `scale`), then take it off the window.
static void LTDismiss(CALayer *layer, CGFloat scale, CFTimeInterval duration) {
  [layer addAnimation:LTAnim(@"opacity", @1, @0, duration) forKey:@"lt.fade"];
  [layer addAnimation:LTAnim(@"transform.scale", @1, @(scale), duration) forKey:@"lt.grow"];
  layer.opacity = 0;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(duration * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [layer removeFromSuperlayer];
  });
}

// ── the glow ─────────────────────────────────────────────────────────────

static const CFTimeInterval kGlowStay = 1.2;  // after the last touch, before it starts to go
static const CFTimeInterval kGlowOut = 0.5;
static CALayer *gGlow;
static BOOL gNoGlow;  // looktap live's page is driving: a person, who needs the pointer but not the glow
static NSUInteger gGlowTurn;  // counts touches: a fade-out scheduled before a later touch does nothing

static void LTGlowLater(NSUInteger turn) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kGlowStay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (turn != gGlowTurn || !gGlow) return;
    if (gDots.count) return LTGlowLater(turn);  // a finger held still: stay on
    [gGlow addAnimation:LTAnim(@"opacity", @1, @0, kGlowOut) forKey:@"lt.glow"];
    gGlow.opacity = 0;
  });
}

/// A glow inside the screen's edge while the app is being touched, and for a moment after: whoever is watching (or
/// the recording) sees that something is driving it. A ring the shape of the screen, whose shadow is the glow.
static void LTGlow(UIWindow *window) {
  if (gNoGlow) return;
  UIScreen *screen = window.screen ?: [LT_CLASS(UIScreen) mainScreen];
  CGRect bounds = window.bounds, whole = screen.bounds;
  // Only a window that fills the screen: around a keyboard or a small panel it would be a box in the middle.
  if (bounds.size.width * bounds.size.height < 0.9 * whole.size.width * whole.size.height) return;
  [LT_CLASS(CATransaction) begin];
  [LT_CLASS(CATransaction) setDisableActions:YES];
  if (!gGlow) {
    gGlow = [LT_CLASS(CALayer) layer];
    gGlow.borderWidth = 3;
    gGlow.borderColor = LTAccent(0.9);
    gGlow.shadowColor = LTAccent(1);
    gGlow.shadowOpacity = 1;
    gGlow.shadowRadius = 14;
    gGlow.shadowOffset = CGSizeMake(0, 0);
    gGlow.zPosition = 1e9 - 2;
    gGlow.opacity = 0;
    CGFloat corner = 0;
    @try {
      corner = [[screen valueForKey:@"_displayCornerRadius"] doubleValue];  // private: the screen's own rounding
    } @catch (id e) {
    }
    gGlow.cornerRadius = corner;
    if (corner > 0) gGlow.cornerCurve = @"continuous";
  }
  if (gGlow.superlayer != window.layer) [window.layer addSublayer:gGlow];
  gGlow.frame = bounds;
  [LT_CLASS(CATransaction) commit];
  if (gGlow.opacity < 1) {
    [gGlow addAnimation:LTAnim(@"opacity", @0, @1, 0.15) forKey:@"lt.glow"];
    gGlow.opacity = 1;
  }
  LTGlowLater(++gGlowTurn);
}

static void LTDraw(UITouch *touch) {
  UIWindow *window = touch.window;
  CALayer *dot = [gDots objectForKey:touch];
  UITouchPhase phase = touch.phase;
  if (phase == UITouchPhaseEnded || phase == UITouchPhaseCancelled) {
    if (dot) LTDismiss(dot, 1.7, kFade);
    [gDots removeObjectForKey:touch];
    [gTrails removeObjectForKey:touch];
    return;
  }
  if (!window) return;
  LTGlow(window);
  CGPoint at = [touch locationInView:nil];
  [LT_CLASS(CATransaction) begin];
  [LT_CLASS(CATransaction) setDisableActions:YES];
  if (!dot) {
    dot = LTDisc(at, kRadius);
    [window.layer addSublayer:dot];
    [dot addAnimation:LTAnim(@"transform.scale", @0.6, @1, 0.08) forKey:@"lt.in"];
    [gDots setObject:dot forKey:touch];
    [gTrails setObject:[NSValue valueWithBytes:&at objCType:@encode(CGPoint)] forKey:touch];
  } else {
    // A touch can outlive the window it began in (a sheet closing under the finger): follow it to the new one.
    if (dot.superlayer != window.layer) [window.layer addSublayer:dot];
    dot.position = at;
    CGPoint last = at;
    [[gTrails objectForKey:touch] getValue:&last];
    CGFloat dx = at.x - last.x, dy = at.y - last.y;
    if (dx * dx + dy * dy >= kTrailStep * kTrailStep) {
      CALayer *speck = LTDisc(last, kTrailRadius);
      speck.zPosition = 1e9 - 1;
      [window.layer addSublayer:speck];
      LTDismiss(speck, 0.4, kFade);
      [gTrails setObject:[NSValue valueWithBytes:&at objCType:@encode(CGPoint)] forKey:touch];
    }
  }
  [LT_CLASS(CATransaction) commit];
}

static void LTClear(void) {
  [gGlow removeFromSuperlayer];
  gGlow = nil;
  for (CALayer *dot in gDots.objectEnumerator.allObjects) [dot removeFromSuperlayer];
  [gDots removeAllObjects];
  [gTrails removeAllObjects];
}

static void LTSendEvent(id self, SEL _cmd, UIEvent *event) {
  ((void (*)(id, SEL, UIEvent *))gSendEvent)(self, _cmd, event);
  if (!gOn || event.type != UIEventTypeTouches) return;
  for (UITouch *touch in event.allTouches) LTDraw(touch);
}

__attribute__((constructor)) static void LTStart(void) {
  Class app = LT_CLASS(UIApplication);
  if (!app) return;  // not a UIKit process: nothing to draw on
  Method m = class_getInstanceMethod(app, sel_registerName("sendEvent:"));
  if (!m) return;
  gDots = [NSMapTable weakToStrongObjectsMapTable];
  gTrails = [NSMapTable weakToStrongObjectsMapTable];
  const char *env = getenv("LOOKTAP_TOUCHES");
  gOn = env ? strcmp(env, "0") != 0 : [[NSUserDefaults standardUserDefaults] boolForKey:@"LooktapTouches"];
  gSendEvent = method_setImplementation(m, (IMP)LTSendEvent);
  // `looktap touches on|off` reaches apps that are already running (in the simulator) through these.
  int token;
  notify_register_dispatch("com.looktap.touches.on", &token, dispatch_get_main_queue(), ^(int t) {
    gOn = YES;
  });
  notify_register_dispatch("com.looktap.touches.off", &token, dispatch_get_main_queue(), ^(int t) {
    gOn = NO;
    LTClear();
  });
  // While looktap live's page drives the simulator, its touches show the pointer without the glow.
  notify_register_dispatch("com.looktap.touches.glow.off", &token, dispatch_get_main_queue(), ^(int t) {
    gNoGlow = YES;
    gGlow.opacity = 0;
  });
  notify_register_dispatch("com.looktap.touches.glow.on", &token, dispatch_get_main_queue(), ^(int t) {
    gNoGlow = NO;
  });
}
