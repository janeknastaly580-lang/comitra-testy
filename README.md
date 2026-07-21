# FineLine

A mobile-first MVP for setting financial goals with a **refundable deposit** and
**friend-judged verification**. Stake money on a goal — get it back if your judge
marks you *done*, or watch it split to the platform, your verifiers, and charity if
you fail.

Built to run locally in the browser (mobile viewport) and structured so it can be
wrapped with **Capacitor** or ported to **React Native** for the Google Play Store.

## Stack

- **React 18 + TypeScript**
- **Vite** dev server / bundler
- **Tailwind CSS** (CSS-variable theming, dark by default — no purple, ever)
- **React Router** (`HashRouter`, so deep links work from `file://` in a WebView)
- **LocalStorage** as a mock database via a swappable async API layer

## Run

```bash
npm install
npm run dev
```

Open the URL Vite prints (default http://localhost:5173). The app renders inside a
centered smartphone frame. Register a local account to start — all data is stored in
your browser's LocalStorage.

```bash
npm run build     # type-check + production build to /dist
npm run preview   # serve the production build
```

## How it works

- **Create a goal**: title, description, category, deadline, deposit (USD, simulated),
  one or more verifiers (judges), and a charity.
- **Verifier link**: each goal generates a shareable judge link
  (`#/verify?challengeId=...&token=...`). The referee opens it to mark the goal
  *done* or *failed* — this resolves the goal. The creator can **never** resolve it.
- **Network payout on failure** (`src/lib/payout.ts`):
  - 15% → app owner (PayPal simulation)
  - 40% → split evenly among **qualifying friends** (mutual follows who marked one
    of their own challenges *Completed* within 24h before the deadline)
  - 45% → chosen charity
  - **No qualifying friends?** Charity gets the full 85%; the owner still gets 15%.
  - Each qualifying friend's amount (to the cent) is shown on the goal and credited
    to their virtual wallet.
- **On success**: 100% of the deposit returns to the user's in-app wallet.
- **Auto-fail**: an active goal whose deadline passes without a *done* verdict is
  forfeited automatically.

## Social module

- **Profiles** (`/profile` → Edit): display name, bio, and avatar — upload your own
  image (stored as Base64 in LocalStorage) or pick one of 6 built-in futuristic
  avatars (`src/components/Avatar.tsx`). The avatar + name appear on goals, in search,
  and on the friends list.
- **Social** (`/social`): real-time user search, Follow / Unfollow, and **mutual
  follow = FRIENDS**. A "My Friends" row lists only mutual connections. 7 demo
  profiles are seeded into LocalStorage with mixed states (some already follow you,
  some don't, some are pre-set friends). Seeding is idempotent per user
  (`seedSocial` in `src/lib/api.ts`).

> To see the **network payout** split in action, fail a goal whose deadline is in
> the last 24h (e.g. create a goal, let it expire, or set its deadline to now).
> Two seeded friends (Nova, Kai) have recent wins and will each receive their
> share; Mira is a friend but her win is >24h old, so she is excluded.

## Anti-cheat referee system (P2P verification)

The deposit can only be released by the **assigned referee** — never by the goal
creator. Two independent gates enforce this:

1. **Step A — Device isolation.** On first launch the app generates a random
   `deviceId` and stores it in LocalStorage (`src/lib/storage.ts` → `getDeviceId`).
   The creator's `deviceId` is saved on the goal as `creatorDeviceId`. When the
   verify link is opened, the panel compares the *current* device's id with
   `creatorDeviceId`. If they match (creator clicked their own link) → hard
   **"Access Denied"**, all buttons hidden.
2. **Step B — Referee phone auth.** On a *different* device the panel still won't
   show the verdict buttons. The referee must type the **exact phone number** the
   creator assigned at goal creation. Only an exact match (after normalization)
   unlocks `Mark as Completed` / `Mark as Failed`.

After a verdict the link is **one-time**: `tokenExpired` is set and re-opening shows
*"This challenge has already been resolved."* The server-style guard chain
(`authorizeReferee` in `src/lib/api.ts`) re-checks the token, device and phone on
every state change, so tampering with the UI alone cannot bypass it.

> Trust model: this is LocalStorage, so it is a *client-side* enforcement of a
> *server-side* design. `src/lib/api.ts` already centralizes every check; porting to
> a real backend means moving `deviceId` validation + phone auth + the
> pending→resolved transition server-side without changing the UI.

### 🧪 How to test the anti-cheat flow on localhost

1. `npm run dev`, register, and **create a goal**. In *Assign Referee* set e.g.
   name `John`, phone `+48 500 100 200`.
2. On the goal page, copy the **Referee link** (looks like
   `http://localhost:5173/#/verify?challengeId=<id>&token=<uuid>`).
3. **Prove the creator can't cheat:** paste that link in the **same** browser/tab.
   You'll get the red **"Access Denied — You cannot referee your own challenge!"**
   (Step A blocks you because the device id matches).
4. **Act as the referee:** open the **same link in an Incognito window** (or a
   different browser / another device). Incognito has *no* stored `creatorDeviceId`,
   so Step A passes and the **phone prompt** appears.
   - Enter a **wrong** number → *"Access denied: this number is not the assigned
     referee."*
   - Enter the **exact** number `+48 500 100 200` → the
     `Mark as Completed` / `Mark as Failed` buttons unlock.
5. Cast a verdict. The wallet updates (100% refund on success, or 15/50/35 split on
   failure). Re-open the link → *"already been resolved"* (one-time token).

## Free vs Premium

Toggle Premium from **Profile → Premium status** (or the paywall in **Premium**) to
test gated features:

| Free | Premium |
| --- | --- |
| Max 2 active goals | Unlimited goals |
| — | Team vs Team leagues (point ranking) |
| — | Custom penalties (auto-email templates) |
| — | 2 emergency passes / month + Freeze mode |
| — | Pro analytics, correlation stats, PDF/text export |
| — | Exclusive themes + Android widget previews |
| Ad placeholder banner | No ads |

## Going native (Android)

The architecture is WebView-ready:

- `base: './'` and `HashRouter` keep routing working from `file://`.
- All persistence is isolated in `src/lib/storage.ts` + `src/lib/api.ts`
  (every API call is already `async`). To ship a real backend
  (Firebase / Node), re-implement `api.ts` and leave the UI untouched.

Typical Capacitor wrap:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap init FineLine com.fineline.app --web-dir=dist
npm run build
npx cap add android
npx cap sync
npx cap open android
```

## Project structure

```
src/
  components/   PhoneFrame, AppLayout, BottomNav, GoalCard, ui primitives…
  context/      AppContext (auth, user, theme, premium)
  lib/          types, constants, storage, mock api, payout, formatters
  views/        Login, Register, Dashboard, CreateGoal, GoalDetail,
                Wallet, Wearables, Profile, Premium, Teams, Analytics,
                Themes, Verifier
```
