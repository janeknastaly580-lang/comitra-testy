package com.fineline.app.appblock;

import android.net.Uri;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Which websites count as "the same thing" as a blocked app.
 *
 * Blocking only the app is trivially defeated by opening the site in a browser,
 * so a blocked app also blocks the pages you would actually *use* it on. It does
 * NOT block everything on the domain: help, legal, privacy and account/billing
 * pages stay reachable, because someone shouldn't be locked out of cancelling a
 * subscription or reading a policy just to keep a goal.
 *
 * The rule is an allow-list on top of a domain match: if the host belongs to a
 * blocked app, the page is blocked unless its subdomain or path is on the
 * allowed list.
 */
final class BlockedSites {

    /** Hosts owned by an app, plus the corners of them that stay open. */
    private static final class SiteRule {
        /** Domains (matched on the host and any subdomain of it). */
        final String[] domains;
        /** Whole subdomains that stay reachable, e.g. "help.instagram.com". */
        final String[] allowedHosts;
        /** Path prefixes that stay reachable, e.g. "/legal". */
        final String[] allowedPaths;

        SiteRule(String[] domains, String[] allowedHosts, String[] allowedPaths) {
            this.domains = domains;
            this.allowedHosts = allowedHosts;
            this.allowedPaths = allowedPaths;
        }
    }

    /** Support/legal paths almost every one of these sites shares. */
    private static final String[] COMMON_ALLOWED_PATHS = {
            "/legal", "/terms", "/tos", "/privacy", "/policies", "/policy",
            "/help", "/support", "/about", "/safety", "/accessibility", "/careers"
    };

    private static final Map<String, SiteRule> RULES = new HashMap<>();

    static {
        RULES.put("com.instagram.android", new SiteRule(
                new String[]{"instagram.com", "instagr.am", "ig.me"},
                new String[]{"help.instagram.com", "about.instagram.com", "privacycenter.instagram.com", "business.instagram.com"},
                COMMON_ALLOWED_PATHS));

        RULES.put("com.zhiliaoapp.musically", new SiteRule(
                new String[]{"tiktok.com"},
                new String[]{"support.tiktok.com", "ads.tiktok.com", "business.tiktok.com",
                        "developers.tiktok.com", "newsroom.tiktok.com", "careers.tiktok.com"},
                merge(COMMON_ALLOWED_PATHS, "/community-guidelines", "/transparency")));

        RULES.put("com.google.android.youtube", new SiteRule(
                new String[]{"youtube.com", "youtu.be", "youtube-nocookie.com"},
                new String[]{"support.youtube.com", "studio.youtube.com", "creatoracademy.youtube.com"},
                merge(COMMON_ALLOWED_PATHS, "/t/", "/howyoutubeworks", "/creators", "/paid_memberships")));

        RULES.put("com.facebook.katana", new SiteRule(
                new String[]{"facebook.com", "fb.com", "fb.me", "messenger.com"},
                new String[]{"help.facebook.com", "about.facebook.com", "business.facebook.com",
                        "privacycenter.facebook.com"},
                COMMON_ALLOWED_PATHS));

        RULES.put("com.twitter.android", new SiteRule(
                new String[]{"twitter.com", "x.com", "t.co"},
                new String[]{"help.twitter.com", "help.x.com", "business.twitter.com", "about.x.com"},
                merge(COMMON_ALLOWED_PATHS, "/en/tos", "/en/privacy", "/settings")));

        RULES.put("com.snapchat.android", new SiteRule(
                new String[]{"snapchat.com", "snap.com"},
                new String[]{"help.snapchat.com", "support.snapchat.com", "values.snap.com"},
                COMMON_ALLOWED_PATHS));

        RULES.put("com.reddit.frontpage", new SiteRule(
                new String[]{"reddit.com", "redd.it", "redditmedia.com"},
                new String[]{"support.reddithelp.com", "reddithelp.com", "redditinc.com"},
                merge(COMMON_ALLOWED_PATHS, "/settings")));

        RULES.put("com.netflix.mediaclient", new SiteRule(
                new String[]{"netflix.com"},
                new String[]{"help.netflix.com", "jobs.netflix.com", "about.netflix.com"},
                // Account pages stay open so a block can never trap a subscription.
                merge(COMMON_ALLOWED_PATHS, "/account", "/cancelplan", "/youraccount", "/signup")));

        RULES.put("com.discord", new SiteRule(
                new String[]{"discord.com", "discord.gg", "discordapp.com"},
                new String[]{"support.discord.com", "discord.com.support"},
                merge(COMMON_ALLOWED_PATHS, "/guidelines", "/acknowledgements")));

        RULES.put("tv.twitch.android.app", new SiteRule(
                new String[]{"twitch.tv"},
                new String[]{"help.twitch.tv", "dashboard.twitch.tv", "dev.twitch.tv"},
                merge(COMMON_ALLOWED_PATHS, "/p/legal", "/p/terms", "/p/security")));

        RULES.put("com.pinterest", new SiteRule(
                new String[]{"pinterest.com", "pin.it"},
                new String[]{"help.pinterest.com", "policy.pinterest.com", "business.pinterest.com"},
                COMMON_ALLOWED_PATHS));

        RULES.put("com.spotify.music", new SiteRule(
                new String[]{"spotify.com", "spotify.link"},
                new String[]{"support.spotify.com", "accounts.spotify.com", "artists.spotify.com",
                        "newsroom.spotify.com"},
                // Billing lives under /account: never lock someone out of it.
                merge(COMMON_ALLOWED_PATHS, "/account", "/premium")));
    }

    private BlockedSites() {}

    private static String[] merge(String[] base, String... extra) {
        String[] out = new String[base.length + extra.length];
        System.arraycopy(base, 0, out, 0, base.length);
        System.arraycopy(extra, 0, out, base.length, extra.length);
        return out;
    }

    /**
     * Does this URL show the blocked app's content?
     *
     * @param packageName the app being blocked
     * @param url         whatever was read out of the browser's address bar
     */
    static boolean matches(String packageName, String url) {
        SiteRule rule = RULES.get(packageName);
        if (rule == null || url == null || url.isEmpty()) return false;

        Uri uri = parse(url);
        if (uri == null) return false;
        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.US);
        if (host.startsWith("www.")) host = host.substring(4);

        boolean ownsHost = false;
        for (String domain : rule.domains) {
            if (host.equals(domain) || host.endsWith("." + domain)) {
                ownsHost = true;
                break;
            }
        }
        if (!ownsHost) return false;

        // Support / legal / account subdomains stay reachable.
        for (String allowed : rule.allowedHosts) {
            if (host.equals(allowed) || host.equals("www." + allowed)) return false;
        }

        String path = uri.getPath() == null ? "/" : uri.getPath().toLowerCase(Locale.US);
        for (String allowedPath : rule.allowedPaths) {
            if (path.startsWith(allowedPath)) return false;
        }
        return true;
    }

    /**
     * Address bars often show a trimmed URL ("tiktok.com/foryou") with no
     * scheme, which `Uri.parse` would read as a path with no host.
     */
    private static Uri parse(String raw) {
        String text = raw.trim();
        if (text.isEmpty()) return null;
        // A search query typed into the omnibox is not a URL.
        if (text.contains(" ")) return null;
        if (!text.contains("://")) text = "https://" + text;
        try {
            return Uri.parse(text);
        } catch (Exception e) {
            return null;
        }
    }
}
