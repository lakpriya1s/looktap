// looktap Android helper: run with app_process as the shell user, nothing installed.
// Holds one UiAutomation connection open so screen reads skip `uiautomator dump`'s reconnect and idle wait.
//
// Protocol (localabstract socket "looktap"): one JSON request per line. Each reply is one JSON line;
// a reply carrying "bytes": N is followed by N raw bytes (a PNG).
package com.looktap;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.List;

public final class Server {
    /** Set by the host at launch (a hash of this jar), so a stale helper is replaced after an upgrade. */
    static String version = "dev";
    static final String SOCKET = "looktap";

    static UiAutomation ua;
    static final Object lock = new Object();

    public static void main(String[] args) throws Exception {
        if (args.length > 0) version = args[0];
        LocalServerSocket server;
        try {
            server = new LocalServerSocket(SOCKET);
        } catch (Exception e) {
            System.err.println("looktap helper already running");
            System.exit(3);
            return;
        }
        // AccessibilityInteractionClient builds Handlers on the main looper; app_process has none by default.
        Looper.prepareMainLooper();
        ua = connect();
        System.err.println("looktap helper " + version + " ready");
        for (;;) {
            final LocalSocket client = server.accept();
            Thread t = new Thread(new Runnable() {
                public void run() {
                    serve(client);
                }
            });
            t.setDaemon(true);
            t.start();
        }
    }

    /** The same UiAutomation the system `uiautomator` tool builds, via hidden constructors. */
    static UiAutomation connect() throws Exception {
        HandlerThread thread = new HandlerThread("looktap-ua");
        thread.start();
        Class<?> connCls = Class.forName("android.app.UiAutomationConnection");
        Class<?> ifaceCls = Class.forName("android.app.IUiAutomationConnection");
        Object conn = connCls.getDeclaredConstructor().newInstance();
        Constructor<UiAutomation> ctor = UiAutomation.class.getDeclaredConstructor(Looper.class, ifaceCls);
        ctor.setAccessible(true);
        UiAutomation u = ctor.newInstance(thread.getLooper(), conn);
        Method c;
        try {
            // FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: leave TalkBack etc. running.
            c = UiAutomation.class.getDeclaredMethod("connect", int.class);
            c.setAccessible(true);
            c.invoke(u, 1);
        } catch (NoSuchMethodException e) {
            c = UiAutomation.class.getDeclaredMethod("connect");
            c.setAccessible(true);
            c.invoke(u);
        }
        AccessibilityServiceInfo info = u.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
                | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        u.setServiceInfo(info);
        return u;
    }

    static void serve(LocalSocket client) {
        try {
            BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            OutputStream out = client.getOutputStream();
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isEmpty()) continue;
                JSONObject req = new JSONObject(line);
                try {
                    synchronized (lock) {
                        handle(req, out);
                    }
                } catch (Throwable e) {
                    reply(out, new JSONObject().put("ok", false).put("error", String.valueOf(e)), null);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            try {
                client.close();
            } catch (Exception ignored) {
            }
        }
    }

    static void reply(OutputStream out, JSONObject head, byte[] body) throws Exception {
        if (body != null) head.put("bytes", body.length);
        out.write((head.toString() + "\n").getBytes(StandardCharsets.UTF_8));
        if (body != null) out.write(body);
        out.flush();
    }

    static JSONObject ok() throws Exception {
        return new JSONObject().put("ok", true);
    }

    static void handle(JSONObject req, OutputStream out) throws Exception {
        String op = req.getString("op");
        switch (op) {
            case "hello":
                reply(out, ok().put("version", version).put("pid", android.os.Process.myPid()), null);
                return;
            case "tree":
                // fresh: drop the node cache first. An app whose events don't reach the cache (or arrive late) can
                // otherwise be read as the screen it showed before a navigation.
                if (req.optBoolean("fresh")) clearCache();
                reply(out, ok().put("nodes", tree(req.optBoolean("all"))).put("display", display()), null);
                return;
            case "display":
                reply(out, ok().put("display", display()), null);
                return;
            case "tap":
                tap(req.getInt("x"), req.getInt("y"), req.optInt("hold", 50));
                reply(out, ok(), null);
                return;
            case "pinch":
                pinch(req.getInt("x"), req.getInt("y"), req.getInt("r0"), req.getInt("r1"), req.optInt("ms", 400));
                reply(out, ok(), null);
                return;
            case "swipe":
                swipe(req.getInt("x1"), req.getInt("y1"), req.getInt("x2"), req.getInt("y2"), req.optInt("ms", 300), req.optInt("hold", 0));
                reply(out, ok(), null);
                return;
            case "text":
                text(req.getString("s"));
                reply(out, ok(), null);
                return;
            case "key": {
                JSONArray names = req.getJSONArray("keys");
                for (int i = 0; i < names.length(); i++) key(names.getString(i));
                reply(out, ok(), null);
                return;
            }
            case "clear":
                reply(out, ok().put("cleared", clear(req.optInt("wait", 1000))), null);
                return;
            case "field":
                reply(out, field(), null);
                return;
            case "blur":
                reply(out, ok().put("blurred", blur()), null);
                return;
            case "front": {
                // The active window's package: the app the user is looking at.
                AccessibilityNodeInfo r = activeRoot();
                CharSequence pkg = r == null ? null : r.getPackageName();
                String p = pkg == null ? "" : pkg.toString();
                reply(out, ok().put("package", p).put("pid", p.isEmpty() ? 0 : pidOf(p)), null);
                return;
            }
            case "keyboard":
                reply(out, ok().put("shown", keyboardShown()), null);
                return;
            case "windows":
                reply(out, ok().put("windows", windows()).put("display", display()), null);
                return;
            case "locked":
                reply(out, ok().put("locked", keyguardLocked()), null);
                return;
            case "shot": {
                Bitmap b = screenshot();
                double scale = req.optDouble("scale", 1);
                if (scale > 0 && scale < 1) {
                    if (b.getConfig() == Bitmap.Config.HARDWARE) b = b.copy(Bitmap.Config.ARGB_8888, false);
                    b = Bitmap.createScaledBitmap(b, Math.max(1, (int) Math.round(b.getWidth() * scale)),
                            Math.max(1, (int) Math.round(b.getHeight() * scale)), true);
                }
                reply(out, ok(), png(b));
                return;
            }
            case "burst":
                burst(out, req.getDouble("seconds"), req.optInt("interval", 0));
                return;
            case "stop":
                reply(out, ok(), null);
                System.exit(0);
                return;
            default:
                reply(out, new JSONObject().put("ok", false).put("error", "unknown op: " + op), null);
        }
    }

    // ── screen ───────────────────────────────────────────────────────────

    /**
     The default display as apps see it: {w, h} in px, turned with the screen, and its rotation (0–3, quarter
     turns counter-clockwise). From the hidden DisplayManagerGlobal; null where that isn't reachable.
     */
    static JSONObject display() {
        try {
            Object dm = Class.forName("android.hardware.display.DisplayManagerGlobal").getMethod("getInstance").invoke(null);
            Object info = dm.getClass().getMethod("getDisplayInfo", int.class).invoke(dm, 0);
            Class<?> c = info.getClass();
            return new JSONObject().put("w", c.getField("logicalWidth").getInt(info)).put("h", c.getField("logicalHeight").getInt(info))
                    .put("rotation", c.getField("rotation").getInt(info));
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     Visible nodes, pre-order, bounds in px: {l: label, c: class, b: [x1,y1,x2,y2], f: focused, v: checked,
     k: clickable, e: editable, p: password, h: a field's hint, t: a field's text (absent while it shows its hint)}.
     */
    static JSONArray tree(boolean allWindows) throws Exception {
        JSONArray outNodes = new JSONArray();
        if (allWindows) {
            List<AccessibilityWindowInfo> ws = ua.getWindows();
            for (AccessibilityWindowInfo w : ws) {
                AccessibilityNodeInfo r = w.getRoot();
                if (r != null) walk(r, outNodes, false);
            }
        } else {
            outNodes = readActive();
        }
        return outNodes;
    }

    /**
     The active window's nodes. The system can keep a stale frame for a window that slid in (an activity
     transition), offsetting every cached node. refresh() asks the app itself, so the root is refreshed on
     each read — one cheap call — and when its bounds turn out stale, every node is refreshed this read.
     */
    static JSONArray readActive() throws Exception {
        JSONArray out = new JSONArray();
        AccessibilityNodeInfo r = null;
        for (int i = 0; i < 10 && r == null; i++) {
            r = activeRoot();
            if (r == null) SystemClock.sleep(50);
        }
        if (r == null) return out;
        Rect cached = new Rect();
        r.getBoundsInScreen(cached);
        r.refresh();
        r.getBoundsInScreen(tmp);
        walk(r, out, !cached.equals(tmp));
        return out;
    }

    static int lastWindowId = Integer.MIN_VALUE;

    /**
     The active window's root. The node cache is dropped when the active window changes — a cached node
     can outlive its window after an app restart — but not on every read: rebuilding a web page's
     accessibility tree on each poll is heavy enough to make Chrome stop responding.
     */
    static AccessibilityNodeInfo activeRoot() {
        AccessibilityNodeInfo r = ua.getRootInActiveWindow();
        if (r != null && r.getWindowId() != lastWindowId) {
            lastWindowId = r.getWindowId();
            clearCache();
            r = ua.getRootInActiveWindow();
        }
        return r;
    }

    /** Drop cached nodes so the next read comes from the app (UiAutomation.clearCache, API 34+; hidden before). */
    static void clearCache() {
        try {
            UiAutomation.class.getMethod("clearCache").invoke(ua);
            return;
        } catch (Throwable ignored) {
        }
        try {
            Class<?> c = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
            Object client = c.getMethod("getInstance").invoke(null);
            c.getMethod("clearCache").invoke(client);
        } catch (Throwable ignored) {
        }
    }

    static final Rect tmp = new Rect();

    static void walk(AccessibilityNodeInfo n, JSONArray out, boolean refresh) throws Exception {
        if (refresh) n.refresh();
        if (!n.isVisibleToUser()) return;
        CharSequence desc = n.getContentDescription();
        CharSequence txt = n.getText();
        String label = desc != null && desc.length() > 0 ? desc.toString() : txt != null ? txt.toString() : "";
        n.getBoundsInScreen(tmp);
        JSONObject o = new JSONObject();
        o.put("l", label);
        o.put("c", n.getClassName() == null ? "" : n.getClassName().toString());
        o.put("b", new JSONArray().put(tmp.left).put(tmp.top).put(tmp.right).put(tmp.bottom));
        if (n.isFocused()) o.put("f", true);
        // A switch's or checkbox's state, as iOS reports it ("1" on, "0" off)
        if (n.isCheckable()) o.put("v", n.isChecked() ? "1" : "0");
        if (n.isClickable() || n.isLongClickable()) o.put("k", true);
        if (n.isEditable()) o.put("e", true);
        if (n.isPassword()) o.put("p", true);
        // An empty field reads as its hint; with text typed, this is the only way to the name it had.
        if (android.os.Build.VERSION.SDK_INT >= 26 && n.isEditable()) {
            if (n.getHintText() != null) o.put("h", n.getHintText().toString());
            if (!n.isShowingHintText() && txt != null) o.put("t", txt.toString());
        }
        out.put(o);
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c != null) walk(c, out, refresh);
        }
    }

    static String cachedPackage = "";
    static int cachedPid = 0;

    /** The main process of `pkg` (its cmdline is the package name), from /proc; the last answer is checked first. */
    static int pidOf(String pkg) {
        if (pkg.equals(cachedPackage) && pkg.equals(cmdline(cachedPid))) return cachedPid;
        java.io.File[] procs = new java.io.File("/proc").listFiles();
        if (procs != null)
            for (java.io.File f : procs) {
                String name = f.getName();
                if (name.isEmpty() || !Character.isDigit(name.charAt(0))) continue;
                int pid = Integer.parseInt(name);
                if (pkg.equals(cmdline(pid))) {
                    cachedPackage = pkg;
                    cachedPid = pid;
                    return pid;
                }
            }
        return 0;
    }

    static String cmdline(int pid) {
        if (pid <= 0) return "";
        try (java.io.FileInputStream in = new java.io.FileInputStream("/proc/" + pid + "/cmdline")) {
            byte[] b = new byte[256];
            int n = in.read(b);
            int end = 0;
            while (end < n && b[end] != 0) end++;
            return new String(b, 0, end, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    /** Empty the focused input field (ACTION_SET_TEXT ""), waiting up to `wait` ms for one to take focus. */
    static boolean clear(int wait) {
        long until = SystemClock.uptimeMillis() + wait;
        for (;;) {
            AccessibilityNodeInfo r = ua.getRootInActiveWindow();
            AccessibilityNodeInfo f = r == null ? null : r.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (f != null && f.isEditable()) {
                android.os.Bundle args = new android.os.Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "");
                return f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
            }
            if (SystemClock.uptimeMillis() >= until) return false;
            SystemClock.sleep(50);
        }
    }

    /**
     The focused input field, even where the keyboard hides it (hidden nodes are left out of the tree):
     {ok, field: false} when none, else {field: true, text, password} (text "" while it shows its hint).
     */
    static JSONObject field() throws Exception {
        AccessibilityNodeInfo r = ua.getRootInActiveWindow();
        AccessibilityNodeInfo f = r == null ? null : r.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f == null || !f.isEditable()) return ok().put("field", false);
        f.refresh();
        CharSequence t = f.getText();
        boolean hint = android.os.Build.VERSION.SDK_INT >= 26 && f.isShowingHintText();
        return ok().put("field", true).put("password", f.isPassword()).put("text", hint || t == null ? "" : t.toString());
    }

    /**
     Take focus away from the focused input field (ACTION_CLEAR_FOCUS), as a tap outside it would: the field's
     blur handlers run (React Native's onBlur) and it gives up the keyboard. False when no field had focus or kept it.
     */
    static boolean blur() {
        AccessibilityNodeInfo r = ua.getRootInActiveWindow();
        AccessibilityNodeInfo f = r == null ? null : r.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (f == null || !f.isEditable()) return false;
        return f.performAction(AccessibilityNodeInfo.ACTION_CLEAR_FOCUS);
    }

    /** The lock screen is up: the window manager's own answer (IWindowManager.isKeyguardLocked, hidden). */
    static boolean keyguardLocked() throws Exception {
        Object wm = Class.forName("android.view.WindowManagerGlobal").getMethod("getWindowManagerService").invoke(null);
        return (Boolean) wm.getClass().getMethod("isKeyguardLocked").invoke(wm);
    }

    /** On-screen windows, top first: {t: type (AccessibilityWindowInfo.TYPE_*), a: active, b: [x1,y1,x2,y2] px}. */
    static JSONArray windows() throws Exception {
        JSONArray out = new JSONArray();
        for (AccessibilityWindowInfo w : ua.getWindows()) {
            w.getBoundsInScreen(tmp);
            out.put(new JSONObject().put("t", w.getType()).put("a", w.isActive()).put("l", w.getLayer())
                    .put("b", new JSONArray().put(tmp.left).put(tmp.top).put(tmp.right).put(tmp.bottom)));
        }
        return out;
    }

    static boolean keyboardShown() {
        for (AccessibilityWindowInfo w : ua.getWindows())
            if (w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
        return false;
    }

    static Bitmap screenshot() {
        Bitmap b = ua.takeScreenshot();
        if (b == null) throw new IllegalStateException("screenshot failed");
        return b;
    }

    static byte[] png(Bitmap b) {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(1 << 20);
        b.compress(Bitmap.CompressFormat.PNG, 100, bos);
        return bos.toByteArray();
    }

    /** Capture as fast as possible (or every `interval` ms); send only frames that differ from the previous one. */
    static void burst(OutputStream out, double seconds, int interval) throws Exception {
        long end = SystemClock.uptimeMillis() + (long) (seconds * 1000);
        Bitmap prev = null;
        int frames = 0, sent = 0;
        while (SystemClock.uptimeMillis() < end) {
            long t = SystemClock.uptimeMillis();
            Bitmap b = screenshot();
            if (b.getConfig() == Bitmap.Config.HARDWARE) b = b.copy(Bitmap.Config.ARGB_8888, false);
            frames++;
            if (prev == null || !prev.sameAs(b)) {
                reply(out, new JSONObject().put("frame", frames).put("ms", t), png(b));
                sent++;
                prev = b;
            }
            long left = interval - (SystemClock.uptimeMillis() - t);
            if (left > 0) SystemClock.sleep(left);
        }
        reply(out, ok().put("done", true).put("frames", frames).put("distinct", sent), null);
    }

    // ── input ────────────────────────────────────────────────────────────

    /** Hidden injectInputEvent(event, sync, waitForAnimations) where present (API 33+): the public one waits for animations. */
    static Method injectNoAnim;

    static {
        try {
            injectNoAnim = UiAutomation.class.getDeclaredMethod("injectInputEvent", android.view.InputEvent.class, boolean.class, boolean.class);
            injectNoAnim.setAccessible(true);
        } catch (Throwable ignored) {
        }
    }

    static void inject(android.view.InputEvent e) {
        inject(e, true);
    }

    /** sync: wait until the event is dispatched (not for animations). Swipe moves go async to keep their pace. */
    static void inject(android.view.InputEvent e, boolean sync) {
        boolean ok;
        try {
            ok = injectNoAnim != null ? (Boolean) injectNoAnim.invoke(ua, e, sync, false) : ua.injectInputEvent(e, sync);
        } catch (Exception x) {
            ok = ua.injectInputEvent(e, sync);
        }
        if (!ok) throw new IllegalStateException("input injection failed");
    }

    static void touch(int action, long down, long at, float x, float y) {
        MotionEvent e = MotionEvent.obtain(down, at, action, x, y, 0);
        e.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        inject(e, action != MotionEvent.ACTION_MOVE);
        e.recycle();
    }

    /** A tap, or with a long `hold` a long press: the finger stays down that long. */
    static void tap(int x, int y, int hold) {
        long down = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, down, down, x, y);
        if (hold > 100) SystemClock.sleep(hold);
        touch(MotionEvent.ACTION_UP, down, Math.max(down + hold, SystemClock.uptimeMillis()), x, y);
    }

    /** A two-pointer event: fingers at (cx ∓ r, cy). Pointer 1 is added/removed with POINTER_DOWN/UP. */
    static void touch2(int action, long down, long at, float cx, float cy, float r, int count) {
        MotionEvent.PointerProperties[] props = new MotionEvent.PointerProperties[count];
        MotionEvent.PointerCoords[] coords = new MotionEvent.PointerCoords[count];
        for (int i = 0; i < count; i++) {
            props[i] = new MotionEvent.PointerProperties();
            props[i].id = i;
            props[i].toolType = MotionEvent.TOOL_TYPE_FINGER;
            coords[i] = new MotionEvent.PointerCoords();
            coords[i].x = i == 0 ? cx - r : cx + r;
            coords[i].y = cy;
            coords[i].pressure = 1;
            coords[i].size = 1;
        }
        MotionEvent e = MotionEvent.obtain(down, at, action, count, props, coords, 0, 0, 1, 1, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
        inject(e, action != MotionEvent.ACTION_MOVE);
        e.recycle();
    }

    /** Two fingers on a horizontal line through (cx, cy), from r0 to r1 px either side: r1 > r0 zooms in. */
    static void pinch(int cx, int cy, int r0, int r1, int ms) {
        int steps = Math.max(2, ms / 10);
        int second = 1 << MotionEvent.ACTION_POINTER_INDEX_SHIFT;
        long down = SystemClock.uptimeMillis();
        touch2(MotionEvent.ACTION_DOWN, down, down, cx, cy, r0, 1);
        touch2(MotionEvent.ACTION_POINTER_DOWN | second, down, down, cx, cy, r0, 2);
        for (int i = 1; i <= steps; i++) {
            long at = down + (long) ms * i / steps;
            long wait = at - SystemClock.uptimeMillis();
            if (wait > 0) SystemClock.sleep(wait);
            touch2(MotionEvent.ACTION_MOVE, down, at, cx, cy, r0 + (r1 - r0) * (float) i / steps, 2);
        }
        long end = SystemClock.uptimeMillis();
        touch2(MotionEvent.ACTION_POINTER_UP | second, down, end, cx, cy, r1, 2);
        touch2(MotionEvent.ACTION_UP, down, end, cx, cy, r1, 1);
    }

    /** `hold`: stay still at the end before lifting, so a list stops where the finger did instead of flinging. */
    static void swipe(int x1, int y1, int x2, int y2, int ms, int hold) {
        // Moves on a fixed clock from `down`, so the gesture takes `ms` however long each injection takes.
        int steps = Math.max(2, ms / 10);
        long down = SystemClock.uptimeMillis();
        touch(MotionEvent.ACTION_DOWN, down, down, x1, y1);
        for (int i = 1; i <= steps; i++) {
            long at = down + (long) ms * i / steps;
            long wait = at - SystemClock.uptimeMillis();
            if (wait > 0) SystemClock.sleep(wait);
            float f = (float) i / steps;
            touch(MotionEvent.ACTION_MOVE, down, at, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f);
        }
        if (hold > 0) {
            // Still moves at the same point: the velocity tracker reads zero, so there is no fling.
            for (long until = SystemClock.uptimeMillis() + hold; SystemClock.uptimeMillis() < until; ) {
                SystemClock.sleep(Math.min(20, hold));
                touch(MotionEvent.ACTION_MOVE, down, SystemClock.uptimeMillis(), x2, y2);
            }
        }
        touch(MotionEvent.ACTION_UP, down, SystemClock.uptimeMillis(), x2, y2);
    }

    /** A KEYCODE_* name, or CTRL+<name> for a shortcut (CTRL+KEYCODE_A selects all). */
    static void key(String name) {
        boolean ctrl = name.startsWith("CTRL+");
        String bare = ctrl ? name.substring(5) : name;
        int code = KeyEvent.keyCodeFromString(bare.startsWith("KEYCODE_") ? bare : "KEYCODE_" + bare);
        if (code == KeyEvent.KEYCODE_UNKNOWN) throw new IllegalArgumentException("unknown key: " + name);
        if (code == KeyEvent.KEYCODE_PASTE && !ctrl) {
            // WebViews and some custom fields ignore the paste key but take the accessibility action.
            if (pasteAction()) return;
        }
        int meta = ctrl ? KeyEvent.META_CTRL_ON | KeyEvent.META_CTRL_LEFT_ON : 0;
        long t = SystemClock.uptimeMillis();
        if (ctrl) inject(keyEvent(t, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_CTRL_LEFT, meta));
        inject(keyEvent(t, KeyEvent.ACTION_DOWN, code, meta));
        inject(keyEvent(t, KeyEvent.ACTION_UP, code, meta));
        if (ctrl) inject(keyEvent(t, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_CTRL_LEFT, 0));
    }

    static KeyEvent keyEvent(long t, int action, int code, int meta) {
        KeyEvent e = new KeyEvent(t, t, action, code, 0, meta, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD);
        return e;
    }

    /** Typed as key presses; text the virtual keyboard has no keys for (accents, emoji, CJK) is pasted. */
    static void text(String s) throws Exception {
        KeyCharacterMap map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD);
        KeyEvent[] events = map.getEvents(s.toCharArray());
        if (events == null) {
            paste(s);
            return;
        }
        for (KeyEvent e : events) {
            KeyEvent k = KeyEvent.changeTimeRepeat(e, SystemClock.uptimeMillis(), 0);
            k.setSource(InputDevice.SOURCE_KEYBOARD);
            inject(k);
        }
    }

    /**
     The focused field's paste action, true only if the field changed: some fields (React Native's TextInput)
     report the action done without pasting, and then only the paste key works.
     */
    static boolean pasteAction() {
        AccessibilityNodeInfo field = ua.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null) return false;
        String before = fieldState(field);
        if (!field.performAction(AccessibilityNodeInfo.ACTION_PASTE)) return false;
        for (int i = 0; i < 10; i++) {
            SystemClock.sleep(30);
            if (field.refresh() && !fieldState(field).equals(before)) return true;
        }
        return false;
    }

    /** Text and selection: a paste changes one of them, even when the pasted text replaces itself. */
    static String fieldState(AccessibilityNodeInfo field) {
        return field.getText() + "\u0000" + field.getTextSelectionStart() + ":" + field.getTextSelectionEnd();
    }

    /** Put `s` on the clipboard and paste it into the focused field. Replaces what the clipboard held. */
    static void paste(String s) throws Exception {
        setClipboard(s);
        if (pasteAction()) return;
        key("PASTE"); // no focused node that took the action: the paste key, which EditTexts handle too
    }

    /**
     The clipboard service as the shell, the way scrcpy sets it: IClipboard.setPrimaryClip, whose arguments
     differ between Android versions (calling package, attribution tag, user id, device id), filled by type.
     */
    static void setClipboard(String s) throws Exception {
        Class<?> sm = Class.forName("android.os.ServiceManager");
        Object binder = sm.getMethod("getService", String.class).invoke(null, "clipboard");
        Object clipboard = Class.forName("android.content.IClipboard$Stub").getMethod("asInterface", android.os.IBinder.class).invoke(null, binder);
        android.content.ClipData clip = android.content.ClipData.newPlainText("looktap", s);
        Method best = null;
        for (Method m : clipboard.getClass().getMethods())
            if (m.getName().equals("setPrimaryClip") && (best == null || m.getParameterTypes().length > best.getParameterTypes().length)) best = m;
        if (best == null) throw new IllegalStateException("this Android has no IClipboard.setPrimaryClip");
        Class<?>[] types = best.getParameterTypes();
        Object[] args = new Object[types.length];
        boolean firstString = true;
        for (int i = 0; i < types.length; i++) {
            if (types[i] == android.content.ClipData.class) args[i] = clip;
            else if (types[i] == String.class) {
                args[i] = firstString ? "com.android.shell" : null; // calling package, then attribution tag
                firstString = false;
            } else if (types[i] == int.class) args[i] = 0; // user 0, default device
        }
        best.invoke(clipboard, args);
    }
}
