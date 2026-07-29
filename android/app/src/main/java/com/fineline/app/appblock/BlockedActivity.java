package com.fineline.app.appblock;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

import com.fineline.app.R;

import java.util.Date;

/**
 * The screen shown instead of a blocked app.
 *
 * It offers no way back into what was blocked: no "ignore", no "5 more minutes",
 * no dismiss. Both buttons lead away (home, or into Comitra to work on the
 * goal), and the back button does the same. Someone who genuinely wants out has
 * to go to Android Settings and turn the accessibility service off, a
 * deliberate speed bump, and the only supported escape.
 */
public class BlockedActivity extends Activity {

    public static final String EXTRA_APP_LABEL = "appLabel";
    public static final String EXTRA_UNTIL = "untilEpochMs";
    public static final String EXTRA_WAS_WEBSITE = "wasWebsite";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_blocked);

        String label = getIntent().getStringExtra(EXTRA_APP_LABEL);
        long until = getIntent().getLongExtra(EXTRA_UNTIL, 0L);
        boolean wasWebsite = getIntent().getBooleanExtra(EXTRA_WAS_WEBSITE, false);
        if (label == null || label.isEmpty()) label = getString(R.string.block_that_app);

        TextView title = findViewById(R.id.block_title);
        TextView body = findViewById(R.id.block_body);
        TextView until_ = findViewById(R.id.block_until);

        title.setText(getString(R.string.block_title, label));
        body.setText(wasWebsite
                ? getString(R.string.block_body_website, label)
                : getString(R.string.block_body_app));

        if (until > 0) {
            CharSequence when = DateFormat.format("EEE, d MMM HH:mm", new Date(until));
            until_.setText(getString(R.string.block_until, when));
            until_.setVisibility(View.VISIBLE);
        } else {
            until_.setVisibility(View.GONE);
        }

        Button openApp = findViewById(R.id.block_open_comitra);
        openApp.setOnClickListener(v -> {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(launch);
            }
            finish();
        });

        Button close = findViewById(R.id.block_close);
        close.setOnClickListener(v -> goHome());
    }

    /**
     * Backing out must not drop the user into the app they were blocked from.
     *
     * Deprecated since API 33 in favour of OnBackPressedCallback, but this app
     * does not opt into predictive back (no `enableOnBackInvokedCallback` in the
     * manifest), so this is still the callback Android invokes, and it is the
     * only one that works down to the minSdk 24 this project supports.
     */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        goHome();
    }

    private void goHome() {
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        home.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(home);
        finish();
    }
}
