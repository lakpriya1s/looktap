// The helper's side of looktap runner for Android (native/android-app, installed only by `looktap runner install`):
// what looktap did on this device, who is driving it, and the person's switch to pause it.
//
// The app connects to the helper on 127.0.0.1:22089. Only the companion app is answered: the connection's uid is
// looked up in /proc/net/tcp(6) and must be the app's. The helper pushes its state (one JSON line) whenever it
// changes; the app sends {"allowed": bool} from its switch, or {"stop": true}.
//
// Paused is kept in /data/local/tmp/looktap-paused too, so a helper that restarts (a looktap upgrade) is still paused.
package com.looktap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedList;
import java.util.List;

final class Companion {
    static final String PACKAGE = "com.looktap.app";
    static final int PORT = 22089;
    static final File PAUSED = new File("/data/local/tmp/looktap-paused");
    /** What the helper refuses while paused: everything that puts input on the screen. */
    static final String PAUSED_ERROR = "paused on the phone: turn Allow control back on in the looktap runner app";

    static volatile boolean allowed = !PAUSED.exists();
    /**
     The pointer (looktap touches), as last switched by the runner app or `looktap touches on|off`: null until either
     says, and then it wins over what each request asks for ("show"), so the phone's switch and the Mac agree.
     */
    static volatile Boolean touches = null;
    static final long started = System.currentTimeMillis();
    static String mac = "", via = "";
    static long lastContact = 0;
    static int clients = 0, actions = 0, reads = 0;
    static final LinkedList<JSONObject> recent = new LinkedList<>();
    static final List<OutputStream> apps = new ArrayList<>();

    /** Is this op refused while paused? A finger already down may still lift. */
    static boolean refused(String op, JSONObject req) {
        if (allowed) return false;
        switch (op) {
            case "tap": case "pinch": case "swipe": case "text": case "paste": case "key": case "clear":
                return true;
            case "touch": {
                String phase = req.optString("phase");
                return phase.equals("down") || phase.equals("move");
            }
            default:
                return false;
        }
    }

    // ── what the helper hears ────────────────────────────────────────────

    /** Is the runner app connected now? Only then is a command's note worth sending. */
    static synchronized boolean connected() {
        return !apps.isEmpty();
    }

    static synchronized void hello(JSONObject req) {
        String h = req.optString("host"), v = req.optString("via");
        if (!h.isEmpty()) mac = h;
        if (!v.isEmpty()) via = v;
        lastContact = System.currentTimeMillis();
        push();
    }

    static synchronized void client(boolean on) {
        clients = Math.max(0, clients + (on ? 1 : -1));
        lastContact = System.currentTimeMillis();
        push();
    }

    /** A looktap command, as the Mac logged it: {what, ok, action}. Reads are only counted. */
    static synchronized void note(JSONObject req) throws Exception {
        lastContact = System.currentTimeMillis();
        if (!req.optBoolean("action")) {
            reads++;
        } else {
            actions++;
            recent.addFirst(new JSONObject().put("t", lastContact).put("what", req.optString("what")).put("ok", req.optBoolean("ok", true)));
            while (recent.size() > 20) recent.removeLast();
        }
        push();
    }

    static synchronized JSONObject state() throws Exception {
        JSONArray list = new JSONArray();
        for (JSONObject e : recent) list.put(e);
        return new JSONObject().put("version", Server.version).put("started", started).put("allowed", allowed).put("mac", mac).put("via", via)
                .put("connected", clients > 0).put("lastContact", lastContact).put("actions", actions).put("reads", reads).put("recent", list)
                .put("touches", touches == null ? JSONObject.NULL : touches).put("now", System.currentTimeMillis());
    }

    /** The state to every app connected. One that can't take it is dropped. */
    static synchronized void push() {
        if (apps.isEmpty()) return;
        byte[] line;
        try {
            line = (state().toString() + "\n").getBytes(StandardCharsets.UTF_8);
        } catch (Exception e) {
            return;
        }
        for (int i = apps.size() - 1; i >= 0; i--) {
            try {
                apps.get(i).write(line);
                apps.get(i).flush();
            } catch (Exception e) {
                apps.remove(i);
            }
        }
    }

    static synchronized void setTouches(boolean on) {
        touches = on;
        push();
    }

    static synchronized void setAllowed(boolean on) {
        allowed = on;
        try {
            if (on) PAUSED.delete();
            else PAUSED.createNewFile();
        } catch (Exception ignored) {
        }
        push();
    }

    // ── the app's connection ─────────────────────────────────────────────

    static void start() {
        Thread t = new Thread(new Runnable() {
            public void run() {
                try {
                    ServerSocket server = new ServerSocket(PORT, 4, InetAddress.getByName("127.0.0.1"));
                    for (;;) {
                        final Socket s = server.accept();
                        Thread c = new Thread(new Runnable() {
                            public void run() {
                                serve(s);
                            }
                        });
                        c.setDaemon(true);
                        c.start();
                    }
                } catch (Exception e) {
                    // The port is taken (an older helper still closing): the app shows "not connected", and the
                    // next helper start tries again.
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    static void serve(Socket s) {
        OutputStream out = null;
        try {
            int uid = uidOf(s.getPort());
            if (uid < 0) return;
            // Reinstalled since it was looked up (a build with another signing key is a new install, a new uid).
            if (uid != appUid()) {
                synchronized (Companion.class) {
                    Companion.uid = -2;
                }
                if (uid != appUid()) return;
            }
            out = s.getOutputStream();
            synchronized (Companion.class) {
                apps.add(out);
            }
            push();
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = in.readLine()) != null) {
                JSONObject m = new JSONObject(line);
                if (m.has("allowed")) setAllowed(m.getBoolean("allowed"));
                if (m.has("touches")) setTouches(m.getBoolean("touches"));
                if (m.optBoolean("stop")) {
                    Server.Pointer.lift();
                    System.exit(0);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            synchronized (Companion.class) {
                if (out != null) apps.remove(out);
            }
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
    }

    /** The uid that owns the local end of a loopback connection from `port` to ours, from /proc/net/tcp and tcp6. */
    static int uidOf(int port) {
        String local = String.format(":%04X", port), remote = String.format(":%04X", PORT);
        for (String f : new String[] {"/proc/net/tcp6", "/proc/net/tcp"}) {
            try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                String line;
                while ((line = r.readLine()) != null) {
                    String[] c = line.trim().split("\\s+");
                    if (c.length > 7 && c[1].endsWith(local) && c[2].endsWith(remote)) return Integer.parseInt(c[7]);
                }
            } catch (Exception ignored) {
            }
        }
        return -1;
    }

    static int uid = -2;

    /** The companion app's uid (-1 when it isn't installed), looked up once per helper. */
    static synchronized int appUid() {
        if (uid != -2) return uid;
        uid = -1;
        try {
            Process p = Runtime.getRuntime().exec(new String[] {"cmd", "package", "list", "packages", "-U", PACKAGE});
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()));
            String line;
            while ((line = r.readLine()) != null) {
                if (line.startsWith("package:" + PACKAGE + " ")) uid = Integer.parseInt(line.replaceAll(".*uid:(\\d+).*", "$1"));
            }
            p.waitFor();
        } catch (Exception ignored) {
        }
        // Not installed yet: look again next time, the app may arrive while this helper runs.
        int found = uid;
        if (found < 0) uid = -2;
        return found;
    }
}
