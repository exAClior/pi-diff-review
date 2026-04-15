import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Container, fuzzyFilter, Input, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";
import { getCurrentBranch, getDefaultBranch, getLocalBranches, getRecentCommits, hasUncommittedChanges } from "./git.js";
import type { ReviewTarget } from "./types.js";

const REVIEW_PRESETS = [
  { value: "uncommitted", label: "Review uncommitted changes", description: "Equivalent to reviewing against HEAD" },
  { value: "baseBranch", label: "Review against a base branch", description: "Pick a local branch to diff against" },
  { value: "commit", label: "Review a specific commit", description: "Review one recent commit without touching the worktree" },
] as const;

type ReviewPresetValue = (typeof REVIEW_PRESETS)[number]["value"];

export async function getSmartDefault(
  pi: ExtensionAPI,
  cwd: string,
): Promise<"uncommitted" | "baseBranch" | "commit"> {
  if (await hasUncommittedChanges(pi, cwd)) {
    return "uncommitted";
  }

  const currentBranch = await getCurrentBranch(pi, cwd);
  const defaultBranch = await getDefaultBranch(pi, cwd);
  if (currentBranch != null && currentBranch !== defaultBranch) {
    return "baseBranch";
  }

  return "commit";
}

export async function showReviewSelector(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<ReviewTarget | null> {
  const smartDefault = await getSmartDefault(pi, ctx.cwd);
  const items: SelectItem[] = REVIEW_PRESETS.map((preset) => ({
    value: preset.value,
    label: preset.label,
    description: preset.description,
  }));
  const smartDefaultIndex = items.findIndex((item) => item.value === smartDefault);

  const preset = await ctx.ui.custom<ReviewPresetValue | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Select a diff review target"))));
    container.addChild(new Spacer(1));

    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    if (smartDefaultIndex >= 0) {
      selectList.setSelectedIndex(smartDefaultIndex);
    }

    selectList.onSelect = (item) => done(item.value as ReviewPresetValue);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "Enter to select • Esc to cancel")));

    return {
      render(width) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  switch (preset) {
    case "uncommitted":
      return { type: "worktree", baseRef: "HEAD" };
    case "baseBranch":
      return await showBranchSelector(pi, ctx);
    case "commit":
      return await showCommitSelector(pi, ctx);
    default:
      return null;
  }
}

export async function showBranchSelector(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<ReviewTarget | null> {
  const branches = await getLocalBranches(pi, ctx.cwd);
  const currentBranch = await getCurrentBranch(pi, ctx.cwd);
  const defaultBranch = await getDefaultBranch(pi, ctx.cwd);
  const candidateBranches = currentBranch == null ? branches : branches.filter((branch) => branch !== currentBranch);

  if (candidateBranches.length === 0) {
    ctx.ui.notify(currentBranch ? `No other branches found (current branch: ${currentBranch}).` : "No branches found.", "error");
    return null;
  }

  const sortedBranches = [...candidateBranches].sort((left, right) => {
    if (left === defaultBranch) return -1;
    if (right === defaultBranch) return 1;
    return left.localeCompare(right);
  });

  const items: SelectItem[] = sortedBranches.map((branch) => ({
    value: branch,
    label: branch,
    description: branch === defaultBranch ? "(default)" : "",
  }));

  const result = await showFilteredSelect(ctx, {
    title: "Select base branch",
    emptyMessage: "No matching branches",
    items,
  });

  return result == null ? null : { type: "worktree", baseRef: result };
}

export async function showCommitSelector(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<ReviewTarget | null> {
  const commits = await getRecentCommits(pi, ctx.cwd, 20);
  if (commits.length === 0) {
    ctx.ui.notify("No commits found.", "error");
    return null;
  }

  const items: SelectItem[] = commits.map((commit) => ({
    value: commit.sha,
    label: `${commit.sha.slice(0, 7)} ${commit.title}`,
    description: "",
  }));

  const result = await showFilteredSelect(ctx, {
    title: "Select commit to review",
    emptyMessage: "No matching commits",
    items,
  });

  return result == null ? null : { type: "commit", sha: result };
}

async function showFilteredSelect(
  ctx: ExtensionCommandContext,
  options: { title: string; emptyMessage: string; items: SelectItem[] },
): Promise<string | null> {
  return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold(options.title))));

    const searchInput = new Input();
    container.addChild(searchInput);
    container.addChild(new Spacer(1));

    const listContainer = new Container();
    container.addChild(listContainer);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "Type to filter • Enter to select • Esc to cancel")));

    let filteredItems = options.items;
    let selectList: SelectList | null = null;

    const updateList = () => {
      listContainer.clear();
      if (filteredItems.length === 0) {
        listContainer.addChild(new Text(theme.fg("warning", `  ${options.emptyMessage}`)));
        selectList = null;
        return;
      }

      selectList = new SelectList(filteredItems, Math.min(filteredItems.length, 10), {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });

      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      listContainer.addChild(selectList);
    };

    const applyFilter = () => {
      const query = searchInput.getValue();
      filteredItems = query
        ? fuzzyFilter(options.items, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`)
        : options.items;
      updateList();
    };

    applyFilter();

    return {
      render(width) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data) {
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.select.cancel")
        ) {
          if (selectList != null) {
            selectList.handleInput(data);
          } else if (keybindings.matches(data, "tui.select.cancel")) {
            done(null);
          }
          tui.requestRender();
          return;
        }

        searchInput.handleInput(data);
        applyFilter();
        tui.requestRender();
      },
    };
  });
}
