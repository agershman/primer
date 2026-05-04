import { useSettingsCtx } from "../SettingsContext";
import { Card, Field, PanelHeader, SourceEnabledRow, ToggleRow, useSourceEnabled } from "../shared";

/**
 * GitHub source configuration. We don't surface an "in scope" preview
 * here yet because the worker's preview endpoint doesn't yet return
 * GitHub PRs (only Linear / Slack / incidents are wired). When that
 * lands, drop in an `<InScopePreview source={previewState.github} />`
 * the same way Linear and Slack do.
 */
export function GitHubPanel() {
  const { settings } = useSettingsCtx();
  const { settings: data, updateSettings } = settings;
  const { enabled, setEnabled } = useSourceEnabled("github");
  if (!data) return null;

  const githubDefaults = {
    repos: [] as string[],
    includeReviewRequested: true,
    includeAssigned: true,
    includeCommented: true,
    includeTeamReviews: false,
    teams: [] as string[],
    updatedWithinDays: 7,
  };
  const github = {
    ...githubDefaults,
    ...((data.signalSurfaceMap as Record<string, unknown>)?.github as Record<string, unknown> | undefined),
  } as typeof githubDefaults;
  const updateGitHub = (partial: Partial<typeof github>) => {
    updateSettings({
      signalSurfaceMap: {
        ...data.signalSurfaceMap,
        github: { ...github, ...partial },
      } as typeof data.signalSurfaceMap,
    });
  };

  return (
    <div>
      <PanelHeader title="GitHub" description="Pull requests and repo activity to include in briefings." />

      <SourceEnabledRow
        enabled={enabled}
        onChange={setEnabled}
        hint="Off by default. Turn on to fan GitHub PRs and issues into your daily briefing — the filters below decide which ones."
      />

      {!enabled ? (
        <div className="text-[11px] font-mono text-text-dim italic">
          GitHub is off for your briefings. Toggle it on to configure which PRs and repos to include.
        </div>
      ) : (
        <>
          <Field label="Pull requests">
            <Card>
              <ToggleRow
                label="Review requested"
                checked={github.includeReviewRequested}
                onChange={(v) => updateGitHub({ includeReviewRequested: v })}
              />
              <ToggleRow
                label="Assigned to me"
                checked={github.includeAssigned}
                onChange={(v) => updateGitHub({ includeAssigned: v })}
              />
              <ToggleRow
                label="Commented on"
                checked={github.includeCommented}
                onChange={(v) => updateGitHub({ includeCommented: v })}
              />
              <ToggleRow
                label="Team review requests"
                checked={github.includeTeamReviews}
                onChange={(v) => updateGitHub({ includeTeamReviews: v })}
                last
              />
            </Card>
          </Field>

          <Field label="Time window" hint="Only include PRs updated recently.">
            <Card>
              <select
                value={github.updatedWithinDays}
                onChange={(e) => updateGitHub({ updatedWithinDays: Number(e.target.value) })}
                className="w-full bg-surface border border-border rounded-md px-3 py-1.5 text-xs font-mono text-text-primary outline-none focus:border-accent transition-colors"
              >
                <option value={3}>Last 3 days</option>
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </Card>
          </Field>

          {github.repos.length > 0 && (
            <Field label="Watched repos">
              <div className="flex flex-wrap gap-1.5">
                {github.repos.map((repo) => (
                  <span
                    key={repo}
                    className="inline-flex items-center rounded-md bg-accent-dim border border-accent/20 px-2 py-1 text-xs font-mono text-accent leading-none"
                  >
                    {repo}
                  </span>
                ))}
              </div>
            </Field>
          )}

          {github.teams.length > 0 && (
            <Field label="Teams">
              <div className="flex flex-wrap gap-1.5">
                {github.teams.map((team) => (
                  <span
                    key={team}
                    className="inline-flex items-center rounded-md bg-accent-dim border border-accent/20 px-2 py-1 text-xs font-mono text-accent leading-none"
                  >
                    {team}
                  </span>
                ))}
              </div>
            </Field>
          )}
        </>
      )}
    </div>
  );
}
