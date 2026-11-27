// looktap runner for Android: what looktap is doing on this phone, and a switch to pause it. The same screen, and the
// same name, as the runner app on a real iPhone (native/ios-device, Panel.swift); here looktap's helper does the work.
//
// All it knows comes from looktap's helper on this phone (native/android, Companion.java), over 127.0.0.1:22089: the
// helper pushes its state as a JSON line whenever it changes, and takes {"allowed": bool} and {"stop": true} back.
// The helper answers only this app (it checks the connection's uid). Nothing else is read or sent anywhere.
package com.looktap.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.format.DateFormat;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    static final int PORT = 22089;

    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService writer = Executors.newSingleThreadExecutor();
    volatile boolean running;
    volatile Socket socket;
    JSONObject state; // null while the helper isn't reachable

    boolean dark;
    int accent, ink, mute, cardBg, pageBg, bad, warn;
    TextView status, last, count, since, version, controlNote;
    View dot;
    Switch allow, touches;
    TextView touchesNote;
    Button stop;
    LinearLayout list;
    boolean updating;
    String shown = "";

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        requestWindowFeature(android.view.Window.FEATURE_NO_TITLE); // the page has its own title
        build();
    }

    @Override
    protected void onResume() {
        super.onResume();
        running = true;
        new Thread(new Runnable() { public void run() { link(); } }, "looktap-link").start();
        tick.run();
    }

    @Override
    protected void onPause() {
        super.onPause();
        running = false;
        main.removeCallbacks(tick);
        close();
    }

    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        build(); // light/dark changed: colours again
        draw();
    }

    // ── the helper ───────────────────────────────────────────────────────

    /** Stay connected while the screen shows: read the helper's state lines; on failure, try again every 2 s. */
    void link() {
        while (running) {
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress("127.0.0.1", PORT), 1000);
                socket = s;
                BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while (running && (line = in.readLine()) != null) {
                    final JSONObject st = new JSONObject(line);
                    main.post(new Runnable() { public void run() { state = st; draw(); } });
                }
            } catch (Exception ignored) {
            }
            socket = null;
            main.post(new Runnable() { public void run() { state = null; draw(); } });
            for (int i = 0; i < 20 && running; i++) sleep(100);
        }
    }

    void send(final JSONObject m) {
        writer.execute(new Runnable() {
            public void run() {
                try {
                    Socket s = socket;
                    if (s == null) return;
                    OutputStream out = s.getOutputStream();
                    out.write((m.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                    out.flush();
                } catch (Exception ignored) {
                }
            }
        });
    }

    void close() {
        try {
            Socket s = socket;
            if (s != null) s.close();
        } catch (Exception ignored) {
        }
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
    }

    // ── the screen ───────────────────────────────────────────────────────

    int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    TextView text(String s, float sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        return t;
    }

    void build() {
        dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        // looktap's colours: the site's accent (#22d3ee) on dark, a deeper teal on light so it reads on white.
        accent = dark ? 0xff22d3ee : 0xff0e7490;
        ink = dark ? 0xffe6edf7 : 0xff0b1220;
        mute = dark ? 0xff8a97ad : 0xff5b6880;
        cardBg = dark ? 0xff111a2b : 0xffffffff;
        pageBg = dark ? 0xff070b14 : 0xfff2f5f9;
        bad = dark ? 0xfff87171 : 0xffb91c1c;
        warn = dark ? 0xfffbbf24 : 0xffb45309;
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        // Dark status and navigation bar icons on the light page, light ones on the dark page.
        getWindow().getDecorView().setSystemUiVisibility(dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(pageBg);
        final LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(page);
        // Under the status bar and above the gesture bar (Android 15 draws apps edge to edge).
        scroll.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                page.setPadding(dp(18), insets.getSystemWindowInsetTop() + dp(20), dp(18), insets.getSystemWindowInsetBottom() + dp(28));
                return insets;
            }
        });

        TextView title = text("looktap runner", 30, ink);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        page.addView(title);
        TextView intro = text("Shows what looktap on your computer is doing on this phone, for you or an AI agent, and lets you pause it.", 15, mute);
        intro.setPadding(0, dp(6), 0, dp(10));
        page.addView(intro);

        dot = new View(this);
        GradientDrawable round = new GradientDrawable();
        round.setShape(GradientDrawable.OVAL);
        dot.setBackground(round);
        status = value();
        last = value();
        count = value();
        since = value();
        version = value();
        LinearLayout conn = card(page, "Connection");
        row(conn, "Status", status, dot);
        row(conn, "Last command", last, null);
        row(conn, "This session", count, null);
        row(conn, "Helper running since", since, null);

        LinearLayout control = card(page, "Control");
        allow = new Switch(this);
        allow.setText("Allow control");
        allow.setTextSize(16);
        allow.setTextColor(ink);
        allow.setOnCheckedChangeListener(new android.widget.CompoundButton.OnCheckedChangeListener() {
            public void onCheckedChanged(android.widget.CompoundButton b, boolean on) {
                if (updating) return;
                try {
                    send(new JSONObject().put("allowed", on));
                } catch (Exception ignored) {
                }
            }
        });
        control.addView(allow, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        controlNote = text("Off: looktap can still see the screen, but can't tap, type, swipe or open apps until you turn it back on.", 13, mute);
        controlNote.setPadding(0, dp(6), 0, dp(4));
        control.addView(controlNote);
        touches = new Switch(this);
        touches.setText("Show touches");
        touches.setTextSize(16);
        touches.setTextColor(ink);
        touches.setPadding(0, dp(10), 0, 0);
        touches.setOnCheckedChangeListener(new android.widget.CompoundButton.OnCheckedChangeListener() {
            public void onCheckedChanged(android.widget.CompoundButton b, boolean on) {
                if (updating) return;
                try {
                    send(new JSONObject().put("touches", on));
                } catch (Exception ignored) {
                }
            }
        });
        control.addView(touches, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        touchesNote = text("A dot where looktap touches, and a glow along the screen's edge while it works, in every app and in recordings. The same as looktap touches on.", 13, mute);
        touchesNote.setPadding(0, dp(6), 0, dp(4));
        control.addView(touchesNote);
        stop = new Button(this, null, android.R.attr.borderlessButtonStyle);
        stop.setText("Stop looktap's helper");
        stop.setAllCaps(false);
        stop.setTextColor(bad);
        stop.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        stop.setPadding(0, 0, 0, 0);
        stop.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Stop looktap's helper?")
                        .setMessage("The pointer and live control stop. The next looktap command starts it again.")
                        .setNegativeButton("Cancel", null)
                        .setPositiveButton("Stop", new android.content.DialogInterface.OnClickListener() {
                            public void onClick(android.content.DialogInterface d, int w) {
                                try {
                                    send(new JSONObject().put("stop", true));
                                } catch (Exception ignored) {
                                }
                            }
                        })
                        .show();
            }
        });
        control.addView(stop);

        LinearLayout recent = card(page, "Recent actions");
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        recent.addView(list);
        shown = "";

        LinearLayout about = card(page, "Helper");
        row(about, "Version", version, null);

        LinearLayout help = card(page, "If looktap can't reach this phone");
        help.addView(text("• Keep it unlocked while looktap works.\n• Keep USB debugging (or Wireless debugging) on, and accept the computer's prompt.\n• Run looktap doctor on the computer: it says what is wrong.\n• Remove this app with: looktap runner remove", 13, mute));

        setContentView(scroll);
    }

    TextView value() {
        TextView v = text("", 15, mute);
        v.setGravity(Gravity.END);
        return v;
    }

    LinearLayout card(LinearLayout page, String name) {
        TextView head = text(name.toUpperCase(), 12, mute);
        head.setLetterSpacing(0.04f);
        head.setPadding(dp(4), dp(18), 0, dp(6));
        page.addView(head);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(16), dp(12), dp(16), dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(cardBg);
        bg.setCornerRadius(dp(14));
        box.setBackground(bg);
        page.addView(box);
        return box;
    }

    void row(LinearLayout box, String name, TextView value, View lead) {
        LinearLayout r = new LinearLayout(this);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(0, dp(5), 0, dp(5));
        if (lead != null) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(10), dp(10));
            lp.setMarginEnd(dp(8));
            r.addView(lead, lp);
        }
        r.addView(text(name, 16, ink));
        r.addView(value, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        value.setPadding(dp(12), 0, 0, 0);
        box.addView(r);
    }

    static String ago(long t, long now) {
        long s = Math.max(0, (now - t) / 1000);
        return s < 5 ? "just now" : s < 60 ? s + " s ago" : s < 3600 ? (s / 60) + " min ago" : (s / 3600) + " h ago";
    }

    final Runnable tick = new Runnable() {
        public void run() {
            draw();
            main.postDelayed(this, 1000);
        }
    };

    void draw() {
        if (status == null) return;
        GradientDrawable d = (GradientDrawable) dot.getBackground();
        updating = true;
        if (state == null) {
            status.setText("looktap isn't running here");
            d.setColor(0xff9aa3b2);
            last.setText("—");
            count.setText("—");
            since.setText("—");
            version.setText("—");
            allow.setEnabled(false);
            touches.setEnabled(false);
            stop.setEnabled(false);
            stop.setAlpha(0.4f);
            controlNote.setText("The switch works while looktap's helper runs: it starts with the next looktap command on this phone.");
            drawList(new JSONArray(), System.currentTimeMillis());
            updating = false;
            return;
        }
        // The helper's clock is this phone's: its own "now" lines its times up even if a state line is old.
        long now = System.currentTimeMillis();
        boolean allowed = state.optBoolean("allowed", true), connected = state.optBoolean("connected");
        String mac = state.optString("mac"), via = state.optString("via");
        String where = mac.isEmpty() ? "" : mac + (via.isEmpty() ? "" : " · " + via);
        // Between commands nothing is connected (each command connects for its run): idle, with whom it was last.
        status.setText(!allowed ? "Paused" : connected ? (where.isEmpty() ? "Connected" : where) : where.isEmpty() ? "Waiting for looktap" : "Idle · " + where);
        d.setColor(!allowed ? warn : connected ? accent : 0xff9aa3b2);
        JSONArray recent = state.optJSONArray("recent");
        JSONObject first = recent != null && recent.length() > 0 ? recent.optJSONObject(0) : null;
        long contact = state.optLong("lastContact");
        last.setText(first != null ? first.optString("what") + " · " + ago(first.optLong("t"), now) : contact > 0 ? "read the screen · " + ago(contact, now) : "none yet");
        int actions = state.optInt("actions"), reads = state.optInt("reads");
        count.setText(actions + (actions == 1 ? " action, " : " actions, ") + reads + (reads == 1 ? " read" : " reads"));
        since.setText(DateFormat.getTimeFormat(this).format(new Date(state.optLong("started"))));
        version.setText(state.optString("version"));
        allow.setEnabled(true);
        allow.setChecked(allowed);
        touches.setEnabled(true);
        touches.setChecked(state.optBoolean("touches", false));
        stop.setEnabled(true);
        stop.setAlpha(1f);
        controlNote.setText("Off: looktap can still see the screen, but can't tap, type, swipe or open apps until you turn it back on.");
        drawList(recent == null ? new JSONArray() : recent, now);
        updating = false;
    }

    /** The list, rebuilt only when it changed (rebuilding each second would reset TalkBack's place); times always. */
    void drawList(JSONArray recent, long now) {
        String key = recent.toString();
        if (!key.equals(shown)) {
            shown = key;
            list.removeAllViews();
            if (recent.length() == 0) list.addView(text("Nothing yet. Taps, typing and app launches show here as looktap does them.", 13, mute));
            for (int i = 0; i < Math.min(12, recent.length()); i++) {
                JSONObject e = recent.optJSONObject(i);
                LinearLayout r = new LinearLayout(this);
                r.setPadding(0, dp(4), 0, dp(4));
                boolean ok = e.optBoolean("ok", true);
                TextView what = text(e.optString("what"), 14, ok ? ink : bad);
                what.setContentDescription(e.optString("what") + (ok ? "" : ", failed"));
                r.addView(what, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                TextView when = text("", 13, mute);
                when.setTag(e.optLong("t"));
                when.setPadding(dp(10), 0, 0, 0);
                r.addView(when);
                list.addView(r);
            }
        }
        for (int i = 0; i < list.getChildCount(); i++) {
            View r = list.getChildAt(i);
            if (r instanceof LinearLayout && ((LinearLayout) r).getChildCount() == 2) {
                TextView when = (TextView) ((LinearLayout) r).getChildAt(1);
                when.setText(ago((Long) when.getTag(), now));
            }
        }
    }
}
