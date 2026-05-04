import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { BootstrapAdminWelcome } from "./components/BootstrapAdminWelcome";
import { ChatButton } from "./components/ChatButton";
import { ChatPanel } from "./components/ChatPanel";
import { CommandPalette } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FirstRunSetup } from "./components/FirstRunSetup";
import { Header } from "./components/Header";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { useChat } from "./hooks/useChat";
import { CurrentUserProvider, useCurrentUser } from "./hooks/useCurrentUser";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { onPrimerEvent } from "./lib/events";
import { AdminSourcesPage } from "./pages/AdminSourcesPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { ArchivePage } from "./pages/ArchivePage";
import { BookmarksPage } from "./pages/BookmarksPage";
import { BriefingPage } from "./pages/BriefingPage";
import { CalibratePage } from "./pages/CalibratePage";
import { ConceptsPage } from "./pages/ConceptsPage";
import { HelpArticlePage } from "./pages/HelpArticlePage";
import { HelpIndexPage } from "./pages/HelpIndexPage";

const ONBOARDING_SKIP_KEY = "primer:onboarding-skipped";

export function App() {
  const [chatOpen, setChatOpen] = useState(false);
  const chat = useChat();
  useKeyboardShortcuts();

  // The Cmd+K command palette can open chat from anywhere — it
  // dispatches `primer:open-chat` rather than threading a callback
  // through props. Same pattern Header uses for Settings / Focus.
  useEffect(() => onPrimerEvent("open-chat", () => setChatOpen(true)), []);

  // Top-level user context drives the first-run check. We deliberately
  // do this at the App level rather than inside BriefingPage so the
  // onboarding overlay shows up on whichever route the user lands on
  // first (deep link, refresh on /concepts, etc.) — not just the
  // root briefing page.
  const { user, loading, refresh } = useCurrentUser();

  // Session-scoped skip: clicking "Skip for now" hides the overlay
  // for the current tab/session. Reopening Primer in a new tab will
  // re-prompt until the user actually saves both statements. Settings
  // panel always lets them complete it later.
  const [skipped, setSkipped] = useState(() => {
    try {
      return sessionStorage.getItem(ONBOARDING_SKIP_KEY) === "1";
    } catch {
      return false;
    }
  });

  const needsOnboarding =
    !loading && !!user && !skipped && (!user.aboutStatement?.trim() || !user.focusStatement?.trim());

  return (
    // `lg:pr-16` reserves a guaranteed 64px right gutter on viewports
    // ≥1024px so the fixed-positioned scroll-timeline rail (which lives
    // at `right-3 w-10` ≈ 52px from the viewport's right edge) never
    // overlaps content. Below `lg`, the rail doesn't render at all
    // (`hidden lg:flex` in ScrollTimeline), so no layout shift is
    // needed there. Fixed-positioned children (chat button, scroll
    // timeline, modals) are unaffected by this padding because
    // `position: fixed` resolves against the viewport, not the parent
    // box. Only the in-flow Header and main content shift left.
    // CurrentUserProvider exposes the resolved /api/me user — including
    // the `isAdmin` flag — to deep components (per-piece "try different
    // model" button, inline VoiceSwitcher, etc.) without prop drilling.
    // Server gates always have the final say; this is a UX hint.
    <CurrentUserProvider user={user}>
      <div className="min-h-screen bg-bg text-text-primary lg:pr-16">
        <Header />
        <main className="mx-auto max-w-[860px] px-4 sm:px-6 py-8 sm:py-10">
          {/*
           * Two-tier error-boundary strategy:
           *
           *   1. The TOP-LEVEL boundary here wraps <Routes> so a render
           *      error in ANY page falls back to a clean inline pane
           *      instead of taking the whole tab down to a blank
           *      screen. The Header, chat button, and command palette
           *      keep working — the user can navigate to a different
           *      page or hit reload from a sane shell. This is the
           *      load-bearing safety net.
           *
           *   2. Each `<Route element>` is wrapped in its own
           *      named boundary. A per-page boundary lets the user
           *      retry rendering THAT page (via the "Try again"
           *      button, which clears the boundary state and
           *      remounts the children) without remounting the
           *      whole app, and it lets devtools / production logs
           *      identify which page failed via the boundary name.
           *      Stacking boundaries this way means the inner
           *      boundary catches first and the outer only fires
           *      if the inner one itself throws (rare, but
           *      possible).
           */}
          <ErrorBoundary name="App">
            <Routes>
              <Route
                path="/"
                element={
                  <ErrorBoundary name="BriefingPage">
                    <BriefingPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/briefing/:date"
                element={
                  <ErrorBoundary name="BriefingPage">
                    <BriefingPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/briefing/:date/:id"
                element={
                  <ErrorBoundary name="BriefingPage">
                    <BriefingPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/concepts"
                element={
                  <ErrorBoundary name="ConceptsPage">
                    <ConceptsPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/concepts/:id"
                element={
                  <ErrorBoundary name="ConceptsPage">
                    <ConceptsPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/calibrate"
                element={
                  <ErrorBoundary name="CalibratePage">
                    <CalibratePage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/archive"
                element={
                  <ErrorBoundary name="ArchivePage">
                    <ArchivePage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/bookmarks"
                element={
                  <ErrorBoundary name="BookmarksPage">
                    <BookmarksPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/analytics"
                element={
                  <ErrorBoundary name="AnalyticsPage">
                    <AnalyticsPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/admin/sources"
                element={
                  <ErrorBoundary name="AdminSourcesPage">
                    <AdminSourcesPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/help"
                element={
                  <ErrorBoundary name="HelpIndexPage">
                    <HelpIndexPage />
                  </ErrorBoundary>
                }
              />
              <Route
                path="/help/:category/:page"
                element={
                  <ErrorBoundary name="HelpArticlePage">
                    <HelpArticlePage />
                  </ErrorBoundary>
                }
              />
            </Routes>
          </ErrorBoundary>
        </main>
        {!chatOpen && <ChatButton onClick={() => setChatOpen(true)} />}
        {chatOpen && <ChatPanel chat={chat} onClose={() => setChatOpen(false)} />}
        <CommandPalette />
        <ShortcutsDialog />

        {needsOnboarding && (
          <FirstRunSetup
            initialAbout={user?.aboutStatement ?? null}
            initialFocus={user?.focusStatement ?? null}
            onComplete={() => {
              try {
                sessionStorage.removeItem(ONBOARDING_SKIP_KEY);
              } catch {
                // sessionStorage can throw in private mode — non-critical.
              }
              refresh();
            }}
            onSkip={() => {
              try {
                sessionStorage.setItem(ONBOARDING_SKIP_KEY, "1");
              } catch {
                // Same — degrade silently.
              }
              setSkipped(true);
            }}
          />
        )}

        {/*
         * The bootstrap-admin welcome dialog. Server-driven: rendered
         * only when /api/me reports `needsBootstrapWelcome` (true when
         * the user is admin and `welcomed_as_admin_at IS NULL`). The
         * onboarding overlay takes priority — a fresh-install admin
         * sets up About + Focus first; the welcome dialog explains
         * their admin powers afterward.
         */}
        {!needsOnboarding && user?.needsBootstrapWelcome && (
          <BootstrapAdminWelcome email={user.email} onDismissed={refresh} />
        )}
      </div>
    </CurrentUserProvider>
  );
}
