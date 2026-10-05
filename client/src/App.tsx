import { useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore,
  Blocks,
  Bot,
  Braces,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  Copy,
  FileText,
  FolderGit2,
  FolderSearch,
  GitBranch,
  HeartPulse,
  Import,
  Info,
  Link2,
  Loader2,
  Lock,
  Package,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  TriangleAlert,
  Webhook,
  X
} from "lucide-react";
import {
  applyProfile,
  commitCatalogImport,
  commitImport,
  createCapability,
  createProfile,
  deactivateProfile,
  forkPlugin,
  getBackups,
  getCapability,
  getDoctor,
  getPluginFile,
  getPluginFiles,
  getProfileOverview,
  getProjects,
  launchProfile,
  previewProfile,
  pruneBackups,
  removeCapability,
  removePluginFile,
  removeProfile,
  restoreBackup,
  restoreBackupGroup,
  savePluginFile,
  scanImport,
  scanImportFolder,
  syncCapabilities,
  syncInstalledPlugins,
  updateCapability,
  updateProfile,
  validatePlugin,
  type CapabilityDraft
} from "./api";
import type {
  ApplyPreview,
  BackupEntry,
  Capability,
  CapabilityKind,
  CapabilitySyncResult,
  DoctorIssue,
  DoctorSeverity,
  ImportCandidate,
  LaunchTarget,
  Profile,
  ProfileOverview,
  ProjectEntry,
  PruneBackupsResult
} from "./types";

type View = "projects" | "profiles" | "catalog" | "backups" | "health";
type CatalogFilter = CapabilityKind | "all" | "unused";
type LaunchOptions = { target: LaunchTarget; yolo: boolean };
type Editor =
  | { type: "capability"; item?: Capability; kind?: CapabilityKind }
  | { type: "profile"; item?: Profile }
  | { type: "import"; candidates?: ImportCandidate[] }
  | { type: "folder-import"; folderPath: string }
  | { type: "plugin"; item: Capability; files: string[]; selected?: string; content?: string }
  | { type: "apply"; preview: ApplyPreview; action: "apply" | "launch"; launch: LaunchOptions }
  | { type: "sync"; ids?: string[] }
  | { type: "prune" };
type Confirmation = { title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void };

const KIND_META: Record<CapabilityKind, { label: string; icon: typeof Plug; color: string }> = {
  mcp: { label: "MCP server", icon: Plug, color: "blue" },
  "installed-plugin": { label: "Installed plugin", icon: Package, color: "purple" },
  "custom-plugin": { label: "Custom plugin", icon: Code2, color: "indigo" },
  skill: { label: "Skill", icon: Sparkles, color: "amber" },
  hook: { label: "Hook", icon: Webhook, color: "teal" },
  instruction: { label: "Instruction", icon: FileText, color: "rose" }
};

const SEVERITY_META: Record<DoctorSeverity, { label: string; icon: typeof Info }> = {
  error: { label: "Errors", icon: CircleAlert },
  warn: { label: "Warnings", icon: TriangleAlert },
  info: { label: "Suggestions", icon: Info }
};

const STATE_META: Record<"applied" | "pending" | "drifted", { label: string; detail: string }> = {
  applied: { label: "Up to date", detail: "The project files match this profile." },
  pending: { label: "Needs reapply", detail: "The profile changed since it was applied. Reapply to update the project files." },
  drifted: { label: "Edited outside Capsule", detail: "The generated files were changed by hand. Reapplying replaces them after a backup." }
};

export function App() {
  const [view, setView] = useState<View>("projects");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [projectPath, setProjectPath] = useState("");
  const [overview, setOverview] = useState<ProfileOverview>({
    capabilities: [],
    profiles: [],
    assignments: []
  });
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [issues, setIssues] = useState<DoctorIssue[] | null>(null);
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (nextProjectPath = projectPath) => {
    setLoading(true);
    setError(null);
    try {
      const [nextProjects, nextOverview, nextBackups, nextIssues] = await Promise.all([
        getProjects(),
        getProfileOverview(nextProjectPath || undefined),
        getBackups(),
        // The audit is advisory: a failing check must not take the whole app down.
        getDoctor().catch(() => null)
      ]);
      setProjects(nextProjects);
      setOverview(nextOverview);
      setBackups(nextBackups);
      setIssues(nextIssues);
      if (!nextProjectPath && nextProjects[0]) setProjectPath(nextProjects[0].path);
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (projectPath) void load(projectPath);
  }, [projectPath]);

  const assignment = overview.assignments.find((item) => item.projectPath === projectPath);
  const assignedProfile = overview.profiles.find((profile) => profile.id === assignment?.profileId);
  const projectOptions = useMemo(() => mergeProjects(projects, overview.assignments), [projects, overview.assignments]);
  const attention = (issues ?? []).filter((issue) => issue.severity !== "info");

  const run = async (operation: () => Promise<void>, success?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      await load();
      if (success) setNotice(success);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const prepareApply = async (profileId: string, action: "apply" | "launch", launch: LaunchOptions) => {
    if (!projectPath) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await previewProfile(profileId, projectPath);
      if (preview.needsOwnershipConfirmation || preview.drifted) {
        setEditor({ type: "apply", preview, action, launch });
      } else {
        await performApply(preview, action, launch, false);
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const performApply = async (preview: ApplyPreview, action: "apply" | "launch", launch: LaunchOptions, force: boolean) => {
    await run(async () => {
      if (action === "launch") {
        const result = await launchProfile(preview.profile.id, preview.projectPath, {
          confirmOwnership: true,
          force,
          target: launch.target,
          yolo: launch.yolo
        });
        const agent = launch.target === "codex" ? "Codex" : "Claude";
        if (!result.launched) {
          await navigator.clipboard?.writeText(result.command);
          setNotice("The terminal could not be opened. The launch command was copied.");
        } else {
          setNotice(`${agent} launched in your terminal.`);
        }
      } else {
        await applyProfile(preview.profile.id, preview.projectPath, {
          confirmOwnership: true,
          force
        });
      }
      setEditor(null);
    }, action === "apply" ? "Profile applied." : undefined);
  };

  const editCapability = async (item: Capability) => {
    try {
      if (item.kind === "custom-plugin") {
        const files = await getPluginFiles(item.id);
        setEditor({ type: "plugin", item, files });
      } else if (item.kind !== "installed-plugin") {
        const raw = await getCapability(item.id, true);
        setEditor({ type: "capability", item: raw });
      }
    } catch (err) {
      setError(message(err));
    }
  };

  const confirm = (next: Confirmation) => setConfirmation(next);

  return (
    <div className="profileApp">
      <aside className="sidebar">
        <div className="logo">
          <span><Bot size={20} /></span>
          <div><strong>Capsule</strong><small>for Claude Code & Codex</small></div>
        </div>
        <nav>
          <NavButton active={view === "projects"} icon={FolderGit2} onClick={() => setView("projects")}>Projects</NavButton>
          <NavButton active={view === "profiles"} icon={Settings2} onClick={() => setView("profiles")}>Profiles</NavButton>
          <NavButton active={view === "catalog"} icon={Blocks} onClick={() => setView("catalog")}>Catalog</NavButton>
          <NavButton active={view === "backups"} icon={ArchiveRestore} onClick={() => setView("backups")}>Backups</NavButton>
          <NavButton active={view === "health"} icon={HeartPulse} onClick={() => setView("health")} badge={attention.length ? { count: attention.length, tone: attention.some((issue) => issue.severity === "error") ? "error" : "warn" } : undefined}>Health</NavButton>
        </nav>
        <button className="sidebarFooter" onClick={() => setView("health")}>
          <span className={`statusDot ${healthTone(issues)}`} />
          {issues === null ? "Health checks unavailable" : attention.length ? `${attention.length} ${attention.length === 1 ? "issue" : "issues"} need attention` : "All checks passed"}
          <small>Local only · {overview.capabilities.length} capabilities</small>
        </button>
      </aside>

      <div className="workspace">
        <header className="workspaceHeader">
          <div>
            <span className="kicker">{view}</span>
            <h1>{titleFor(view)}</h1>
          </div>
          <div className="headerActions">
            <button className="iconBtn" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
              {loading ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
            </button>
            {view === "catalog" && (
              <>
                <button className="secondaryBtn" onClick={() => setEditor({ type: "folder-import", folderPath: defaultScanFolder(projects, projectPath) })}>
                  <FolderSearch size={16} /> Scan folder
                </button>
                <button className="secondaryBtn" onClick={() => void run(async () => { await syncInstalledPlugins(); }, "Plugin inventory refreshed.")}>
                  <Package size={16} /> Sync plugins
                </button>
                <button className="secondaryBtn" disabled={!overview.capabilities.some(isLinked)} title="Re-read linked skills and instructions from their source files" onClick={() => setEditor({ type: "sync" })}>
                  <Link2 size={16} /> Sync sources
                </button>
              </>
            )}
            {view !== "health" && (
              <button className="primaryBtn" onClick={() => openPrimaryEditor(view, setEditor)}>
                {view === "projects" ? <Import size={16} /> : view === "backups" ? <Trash2 size={16} /> : <Plus size={16} />}
                {view === "projects" ? "Import setup" : view === "profiles" ? "New profile" : view === "catalog" ? "New capability" : "Clean up"}
              </button>
            )}
            {view === "health" && (
              <button className="primaryBtn" onClick={() => void load()}><HeartPulse size={16} />Run checks</button>
            )}
          </div>
        </header>

        {error && <div className="alert error"><CircleAlert size={17} /><span>{error}</span><button aria-label="Dismiss" onClick={() => setError(null)}><X size={15} /></button></div>}
        {notice && <div className="alert success"><Check size={17} /><span>{notice}</span><button aria-label="Dismiss" onClick={() => setNotice(null)}><X size={15} /></button></div>}

        {view === "projects" && (
          <ProjectsView
            projects={projectOptions}
            projectPath={projectPath}
            onProjectChange={setProjectPath}
            profiles={overview.profiles}
            assignments={overview.assignments}
            assignment={assignment}
            assignedProfile={assignedProfile}
            capabilities={overview.capabilities}
            busy={busy}
            onApply={prepareApply}
            onOpenCatalog={() => setView("catalog")}
            onDeactivate={() => confirm({
              title: "Deactivate this profile?",
              body: <>Capsule stops managing <code>{projectPath}</code> and restores the project files it backed up before the first apply.</>,
              confirmLabel: "Deactivate",
              danger: true,
              onConfirm: () => void run(() => deactivateProfile(projectPath), "Profile deactivated and original files restored.")
            })}
          />
        )}
        {view === "profiles" && (
          <ProfilesView
            profiles={overview.profiles}
            capabilities={overview.capabilities}
            assignments={overview.assignments}
            onEdit={(item) => setEditor({ type: "profile", item })}
            onDelete={(item) => confirm({
              title: `Delete “${item.name}”?`,
              body: "The profile is removed from Capsule. Catalog items stay in the catalog.",
              confirmLabel: "Delete profile",
              danger: true,
              onConfirm: () => void run(() => removeProfile(item.id), "Profile deleted.")
            })}
          />
        )}
        {view === "catalog" && (
          <CatalogView
            capabilities={overview.capabilities}
            profiles={overview.profiles}
            filter={catalogFilter}
            onFilter={setCatalogFilter}
            onAdd={(kind) => setEditor({ type: "capability", kind })}
            onEdit={(item) => void editCapability(item)}
            onSync={(item) => setEditor({ type: "sync", ids: [item.id] })}
            onFork={(item) => void run(async () => { await forkPlugin(item.id); }, "Editable plugin copy created.")}
            onDelete={(item) => confirm({
              title: `Delete “${item.name}”?`,
              body: "It is removed from the catalog. Profiles do not use it, so no project changes.",
              confirmLabel: "Delete capability",
              danger: true,
              onConfirm: () => void run(() => removeCapability(item.id), "Capability deleted.")
            })}
          />
        )}
        {view === "backups" && (
          <BackupsView
            backups={backups}
            onRestore={(backup) => confirm({
              title: "Restore this backup?",
              body: <>The current <code>{backup.sourcePath}</code> is replaced with the saved copy. Capsule backs up the current file first.</>,
              confirmLabel: "Restore",
              onConfirm: () => void run(() => restoreBackup(backup.id), "Backup restored.")
            })}
            onRestoreGroup={(groupId, count) => confirm({
              title: `Restore ${count} files?`,
              body: "Every file in this set is replaced with its saved copy. Capsule backs up the current files first.",
              confirmLabel: "Restore set",
              onConfirm: () => void run(() => restoreBackupGroup(groupId), "Backup set restored.")
            })}
          />
        )}
        {view === "health" && (
          <HealthView
            issues={issues}
            loading={loading}
            profiles={overview.profiles}
            capabilities={overview.capabilities}
            onOpenProfile={(profile) => { setView("profiles"); setEditor({ type: "profile", item: profile }); }}
            onOpenCapability={(item) => { setView("catalog"); void editCapability(item); }}
            onOpenProject={(path) => { setProjectPath(path); setView("projects"); }}
            onOpenUnused={() => { setCatalogFilter("unused"); setView("catalog"); }}
            onOpenBackups={() => { setView("backups"); setEditor({ type: "prune" }); }}
          />
        )}
      </div>

      {editor?.type === "capability" && (
        <CapabilityEditor
          item={editor.item}
          initialKind={editor.kind}
          onClose={() => setEditor(null)}
          onSave={(draft) => void run(async () => {
            if (editor.item) await updateCapability(editor.item.id, draft);
            else await createCapability(draft);
            setEditor(null);
          }, "Capability saved.")}
        />
      )}
      {editor?.type === "profile" && (
        <ProfileEditor
          item={editor.item}
          capabilities={overview.capabilities}
          profiles={overview.profiles}
          onClose={() => setEditor(null)}
          onSave={(draft) => void run(async () => {
            if (editor.item) await updateProfile(editor.item.id, draft);
            else await createProfile(draft);
            setEditor(null);
          }, "Profile saved.")}
        />
      )}
      {editor?.type === "import" && (
        <ImportEditor
          candidates={editor.candidates}
          projectPath={projectPath}
          onCandidates={(candidates) => setEditor({ type: "import", candidates })}
          onClose={() => setEditor(null)}
          onImport={(ids, name) => void run(async () => {
            await commitImport(ids, name);
            setEditor(null);
            setView("profiles");
          }, "Configuration imported into the catalog.")}
        />
      )}
      {editor?.type === "folder-import" && (
        <FolderImportEditor
          initialFolderPath={editor.folderPath}
          onClose={() => setEditor(null)}
          onImport={(ids) => void run(async () => {
            await commitCatalogImport(ids);
            setEditor(null);
            setView("catalog");
          }, `${ids.length} capabilities imported into the catalog. No profiles were changed.`)}
        />
      )}
      {editor?.type === "plugin" && (
        <PluginEditor
          state={editor}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSave={(file, content) => void run(() => savePluginFile(editor.item.id, file, content), "Plugin file saved.")}
          onCreate={() => {
            const file = window.prompt("New file path (inside the plugin workspace)", "skills/new-skill/SKILL.md");
            if (!file) return;
            void run(async () => {
              await savePluginFile(editor.item.id, file, "");
              const files = await getPluginFiles(editor.item.id);
              setEditor({ ...editor, files, selected: file, content: "" });
            }, "Plugin file created.");
          }}
          onDelete={() => {
            if (!editor.selected || !window.confirm(`Delete ${editor.selected}? A backup will be created.`)) return;
            void run(async () => {
              await removePluginFile(editor.item.id, editor.selected!);
              const files = await getPluginFiles(editor.item.id);
              setEditor({ ...editor, files, selected: undefined, content: undefined });
            }, "Plugin file removed and backed up.");
          }}
          onValidate={() => void run(async () => {
            const result = await validatePlugin(editor.item.id);
            if (!result.ok) throw new Error(result.output || "Plugin validation failed.");
            setNotice(result.output || "Plugin is valid.");
          })}
        />
      )}
      {editor?.type === "apply" && (
        <ApplyDialog
          state={editor}
          onClose={() => setEditor(null)}
          onConfirm={() => void performApply(editor.preview, editor.action, editor.launch, editor.preview.drifted)}
        />
      )}
      {editor?.type === "sync" && (
        <SyncDialog
          ids={editor.ids}
          onClose={() => setEditor(null)}
          onApply={(ids) => void run(async () => {
            await syncCapabilities(ids);
            setEditor(null);
          }, `${ids.length} ${ids.length === 1 ? "capability" : "capabilities"} updated from source. Reapply profiles that use them to update projects.`)}
        />
      )}
      {editor?.type === "prune" && (
        <PruneDialog
          onClose={() => setEditor(null)}
          onConfirm={(options, result) => void run(async () => {
            await pruneBackups(options);
            setEditor(null);
          }, `Deleted ${result.deletedCount} backups and freed ${formatBytes(result.bytesFreed)}.`)}
        />
      )}
      {confirmation && (
        <ConfirmDialog
          state={confirmation}
          onClose={() => setConfirmation(null)}
          onConfirm={() => { setConfirmation(null); confirmation.onConfirm(); }}
        />
      )}
      {busy && <div className="busyOverlay"><Loader2 className="spin" size={28} /></div>}
    </div>
  );
}

function ProjectsView(props: {
  projects: ProjectEntry[];
  projectPath: string;
  onProjectChange: (value: string) => void;
  profiles: Profile[];
  assignments: ProfileOverview["assignments"];
  assignment?: ProfileOverview["assignments"][number];
  assignedProfile?: Profile;
  capabilities: Capability[];
  busy: boolean;
  onApply: (profileId: string, action: "apply" | "launch", launch: LaunchOptions) => void;
  onOpenCatalog: () => void;
  onDeactivate: () => void;
}) {
  const [selected, setSelected] = useState(props.assignment?.profileId ?? props.profiles[0]?.id ?? "");
  const [target, setTarget] = useState<LaunchTarget>("claude");
  const [yolo, setYolo] = useState(false);
  useEffect(() => setSelected(props.assignment?.profileId ?? props.profiles[0]?.id ?? ""), [props.assignment?.profileId, props.profiles]);
  const profile = props.profiles.find((item) => item.id === selected);
  const inherited = useMemo(() => profile ? inheritedSources(profile, props.profiles) : new Map<string, string>(), [profile, props.profiles]);
  const resolved = props.capabilities.filter((item) => effectiveIds(profile).includes(item.id));
  const own = resolved.filter((item) => !inherited.has(item.id));
  const fromParents = resolved.filter((item) => inherited.has(item.id));
  const isVanilla = profile?.system === "vanilla";
  const launch = { target, yolo: yolo && !isVanilla };
  const state = props.assignment?.state;
  const assignedHere = props.assignment?.profileId === selected;
  const profileName = (id: string) => props.profiles.find((item) => item.id === id)?.name;
  return (
    <div className="pageGrid projectsGrid">
      <section className="workflowGuide">
        <div><span>1</span><strong>Add capabilities</strong><small>Create MCPs, skills, hooks, and instructions in Catalog.</small></div>
        <ChevronRight size={17} />
        <div><span>2</span><strong>Build a profile</strong><small>Pick catalog items, or extend profiles you already have.</small></div>
        <ChevronRight size={17} />
        <div><span>3</span><strong>Apply or launch</strong><small>Reuse that profile in any project, with Claude Code or Codex.</small></div>
        <button className="secondaryBtn small" onClick={props.onOpenCatalog}>Open Catalog</button>
      </section>
      <section className="panel projectPickerPanel">
        <div className="panelHeader"><div><span className="eyebrow">Repository</span><h2>Choose a project</h2></div></div>
        <label className="field"><span>Project directory</span><select value={props.projectPath} onChange={(event) => props.onProjectChange(event.target.value)}>
          <option value="">Select a project</option>
          {props.projects.map((project) => { const assigned = props.assignments.find((item) => item.projectPath === project.path); const name = assigned && profileName(assigned.profileId); return <option key={project.path} value={project.path}>{name ? `${project.name} · ${name}` : project.name}</option>; })}
        </select></label>
        <div className="pathBox"><FolderGit2 size={18} /><code title={props.projectPath}>{props.projectPath || "No project selected"}</code></div>
        {props.assignment && state ? (
          <div className={`assignmentStatus ${state}`}>
            <span className="statusDot" />
            <div><strong>{props.assignedProfile?.name ?? "Unknown profile"}</strong><small>{STATE_META[state].label}</small><p>{STATE_META[state].detail}</p></div>
            {state !== "applied" && <button className="secondaryBtn small" disabled={props.busy} onClick={() => props.onApply(props.assignment!.profileId, "apply", launch)}><RotateCcw size={14} />Reapply</button>}
          </div>
        ) : <div className="emptyState compact">No profile is assigned to this project. Running Claude here uses your own setup untouched.</div>}
      </section>

      <section className="panel profileChooser">
        <div className="panelHeader"><div><span className="eyebrow">Profile catalog</span><h2>Apply anywhere</h2><p>Profiles are global; the generated Claude files are project-local.</p></div></div>
        <div className="profileOptions">
          {props.profiles.map((item) => (
            <button key={item.id} className={`profileOption ${selected === item.id ? "selected" : ""}`} onClick={() => setSelected(item.id)}>
              <span className="profileGlyph">{item.system ? <Sparkles size={18} /> : <Settings2 size={18} />}</span>
              <span><strong>{item.name}</strong><small>{item.description || profileSummary(item)}</small></span>
              {selected === item.id && <Check size={17} />}
            </button>
          ))}
        </div>
        <div className="capabilityPreview">
          <span>Resolved capabilities{resolved.length > 0 && ` · ${resolved.length}`}</span>
          {resolved.length ? <>
            {own.length > 0 && <div className="chips">{own.map((item) => <KindChip key={item.id} item={item} />)}</div>}
            {fromParents.length > 0 && <div className="inheritedBlock"><small><GitBranch size={12} />Inherited from {[...new Set(fromParents.map((item) => inherited.get(item.id)!))].join(", ")}</small><div className="chips">{fromParents.map((item) => <KindChip key={item.id} item={item} inherited={inherited.get(item.id)} />)}</div></div>}
          </> : <small>{isVanilla ? "Safe mode — Claude Code with every customization disabled" : "None — clean Claude Code"}</small>}
        </div>
        <div className="launchOptions">
          <div className="segmented" role="radiogroup" aria-label="Launch with">
            <button role="radio" aria-checked={target === "claude"} className={target === "claude" ? "active" : ""} onClick={() => setTarget("claude")}>Claude Code</button>
            <button role="radio" aria-checked={target === "codex"} className={target === "codex" ? "active" : ""} onClick={() => setTarget("codex")}>Codex</button>
          </div>
          <label className={`inlineToggle ${isVanilla ? "disabled" : ""}`} title={isVanilla ? "Vanilla starts in safe mode, so permission prompts stay on." : undefined}>
            <input type="checkbox" checked={yolo && !isVanilla} disabled={isVanilla} onChange={(event) => setYolo(event.target.checked)} />
            <span><strong>Skip permission prompts</strong><small>{target === "codex" ? "Passes --dangerously-bypass-approvals-and-sandbox" : "Passes --dangerously-skip-permissions"}</small></span>
          </label>
        </div>
        <div className="buttonRow">
          {props.assignment && <button className="dangerBtn" onClick={props.onDeactivate}><Power size={16} />Deactivate</button>}
          <button className="secondaryBtn" disabled={!selected || !props.projectPath || props.busy} onClick={() => props.onApply(selected, "apply", launch)}><Save size={16} />{assignedHere ? "Reapply" : "Apply"}</button>
          <button className="primaryBtn" disabled={!selected || !props.projectPath || props.busy} onClick={() => props.onApply(selected, "launch", launch)}><Play size={16} />Launch {target === "codex" ? "Codex" : "Claude"}</button>
        </div>
      </section>
    </div>
  );
}

function ProfilesView(props: {
  profiles: Profile[];
  capabilities: Capability[];
  assignments: ProfileOverview["assignments"];
  onEdit: (item: Profile) => void;
  onDelete: (item: Profile) => void;
}) {
  return <div className="cardGrid">{props.profiles.map((profile) => {
    const effective = effectiveIds(profile);
    const items = props.capabilities.filter((item) => effective.includes(item.id));
    const ownCount = items.filter((item) => profile.capabilityIds.includes(item.id)).length;
    const parentNames = (profile.extends ?? []).map((id) => props.profiles.find((candidate) => candidate.id === id)?.name ?? id);
    const children = props.profiles.filter((candidate) => candidate.extends?.includes(profile.id));
    const assigned = props.assignments.filter((item) => item.profileId === profile.id);
    const stale = assigned.filter((item) => item.state !== "applied").length;
    const blocked = children.length
      ? `Extended by ${children.map((child) => child.name).join(", ")}. Remove it from their Extends first.`
      : assigned.length ? `Used by ${assigned.length} ${assigned.length === 1 ? "project" : "projects"}. Deactivate or switch them first.` : undefined;
    return <article className="profileCard" key={profile.id}>
      <div className="cardTop"><span className={`largeGlyph ${profile.system ? "vanilla" : ""}`}>{profile.system ? <Sparkles /> : <Settings2 />}</span><div className="cardActions">
        {!profile.system && <button className="iconBtn" aria-label={`Edit ${profile.name}`} title="Edit" onClick={() => props.onEdit(profile)}><Settings2 size={15} /></button>}
        {!profile.system && <button className="iconBtn danger" aria-label={`Delete ${profile.name}`} title={blocked ?? "Delete"} disabled={Boolean(blocked)} onClick={() => props.onDelete(profile)}><Trash2 size={15} /></button>}
      </div></div>
      <h3>{profile.name}</h3><p>{profile.description || (profile.system ? "Built in" : "No description")}</p>
      {(parentNames.length > 0 || children.length > 0) && <div className="lineage">
        {parentNames.length > 0 && <span><GitBranch size={12} />Extends <strong>{parentNames.join(", ")}</strong></span>}
        {children.length > 0 && <span><Blocks size={12} />Base for <strong>{children.map((child) => child.name).join(", ")}</strong></span>}
      </div>}
      <div className="chips">{items.slice(0, 5).map((item) => <KindChip key={item.id} item={item} inherited={profile.capabilityIds.includes(item.id) ? undefined : "parent"} />)}{items.length > 5 && <span className="moreChip">+{items.length - 5}</span>}</div>
      <footer>
        <span>{items.length} capabilities{items.length > ownCount && ` · ${items.length - ownCount} inherited`}</span>
        <span className={stale ? "warnText" : ""}>{assigned.length} {assigned.length === 1 ? "project" : "projects"}{stale > 0 && ` · ${stale} need reapply`}</span>
      </footer>
    </article>;
  })}</div>;
}

function CatalogView(props: {
  capabilities: Capability[];
  profiles: Profile[];
  filter: CatalogFilter;
  onFilter: (filter: CatalogFilter) => void;
  onAdd: (kind: CapabilityKind) => void;
  onEdit: (item: Capability) => void;
  onSync: (item: Capability) => void;
  onFork: (item: Capability) => void;
  onDelete: (item: Capability) => void;
}) {
  const [query, setQuery] = useState("");
  const usage = useMemo(() => {
    const direct = new Map<string, string[]>();
    const effective = new Set<string>();
    for (const profile of props.profiles) {
      for (const id of profile.capabilityIds) direct.set(id, [...(direct.get(id) ?? []), profile.name]);
      for (const id of effectiveIds(profile)) effective.add(id);
    }
    return { direct, effective };
  }, [props.profiles]);
  const unusedCount = props.capabilities.filter((item) => !usage.effective.has(item.id)).length;
  const needle = query.trim().toLocaleLowerCase();
  const items = props.capabilities.filter((item) => {
    if (props.filter === "unused" ? usage.effective.has(item.id) : props.filter !== "all" && item.kind !== props.filter) return false;
    if (!needle) return true;
    return [item.name, item.description, item.sourcePath, KIND_META[item.kind].label].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(needle));
  });
  return <div className="catalogLayout">
    <section className="catalogGuide">
      <div className="catalogGuideCopy"><span className="eyebrow">Capability library</span><h2>Add once, reuse in profiles</h2><p>Each item below becomes a reusable building block. Add it here, then include it in one or more profiles.</p></div>
      <div className="quickAddGrid">
        {(["mcp", "skill", "hook", "instruction"] as CapabilityKind[]).map((kind) => {
          const meta = KIND_META[kind]; const Icon = meta.icon;
          return <button key={kind} onClick={() => props.onAdd(kind)}><span className={`kindIcon ${meta.color}`}><Icon size={17} /></span><span><strong>Add {kind === "mcp" ? "MCP" : meta.label}</strong><small>{capabilityHint(kind)}</small></span></button>;
        })}
      </div>
    </section>
    <div className="filterBar"><button className={props.filter === "all" ? "active" : ""} onClick={() => props.onFilter("all")}>All <span>{props.capabilities.length}</span></button>
      {(Object.keys(KIND_META) as CapabilityKind[]).map((kind) => <button key={kind} className={props.filter === kind ? "active" : ""} onClick={() => props.onFilter(kind)}>{KIND_META[kind].label}<span>{props.capabilities.filter((item) => item.kind === kind).length}</span></button>)}
      <hr />
      <button className={props.filter === "unused" ? "active" : ""} title="Not part of any profile, directly or through Extends" onClick={() => props.onFilter("unused")}>Unused<span>{unusedCount}</span></button>
    </div>
    <div className="catalogColumn">
      <SearchBox value={query} onChange={setQuery} placeholder="Search by name, description, or source path…" />
      <div className="catalogList">{items.length ? items.map((item) => {
        const meta = KIND_META[item.kind]; const Icon = meta.icon;
        const usedBy = usage.direct.get(item.id) ?? [];
        const fileCount = Object.keys(item.files ?? {}).length;
        const linked = isLinked(item);
        return <article className="catalogRow" key={item.id}><span className={`kindIcon ${meta.color}`}><Icon size={18} /></span><div className="catalogIdentity"><strong>{item.name}</strong><small>{item.description || meta.label}</small>
          <span className="rowMeta">
            {linked && <span className="metaTag" title={item.sourcePath}><Link2 size={11} />Linked to source</span>}
            {fileCount > 0 && <span className="metaTag"><FileText size={11} />{fileCount + 1} files</span>}
            {usedBy.length ? <span className="metaTag">In {usedBy.join(", ")}</span> : usage.effective.has(item.id) ? <span className="metaTag">Inherited only</span> : <span className="metaTag muted">Unused</span>}
          </span>
        </div><span className="kindLabel">{meta.label}</span><div className="rowButtons">
          {linked && <button className="iconBtn" aria-label={`Sync ${item.name} from source`} title="Sync from source" onClick={() => props.onSync(item)}><RefreshCw size={15} /></button>}
          {item.kind === "installed-plugin" && <button className="secondaryBtn small" onClick={() => props.onFork(item)}><Copy size={14} />Custom copy</button>}
          {item.kind !== "installed-plugin" && <button className="iconBtn" aria-label={`Edit ${item.name}`} title="Edit" onClick={() => props.onEdit(item)}><ChevronRight size={16} /></button>}
          {item.kind !== "installed-plugin" && <button className="iconBtn danger" aria-label={`Delete ${item.name}`} disabled={usedBy.length > 0} title={usedBy.length ? `Used by ${usedBy.join(", ")}. Remove it from those profiles first.` : "Delete"} onClick={() => props.onDelete(item)}><Trash2 size={15} /></button>}
        </div></article>;
      }) : <div className="emptyState">{needle ? "Nothing matches this search." : props.filter === "unused" ? "Every capability is part of a profile." : "No capabilities in this category. Use an Add button above to create one."}</div>}</div>
    </div>
  </div>;
}

const BACKUP_PAGE = 50;

function BackupsView(props: { backups: BackupEntry[]; onRestore: (item: BackupEntry) => void; onRestoreGroup: (groupId: string, count: number) => void }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(BACKUP_PAGE);
  const needle = query.trim().toLocaleLowerCase();
  const entries = useMemo(() => {
    const groups = new Map<string, BackupEntry[]>();
    for (const item of props.backups) {
      if (needle && ![item.sourcePath, item.reason].some((value) => value.toLocaleLowerCase().includes(needle))) continue;
      const key = item.groupId ? `group:${item.groupId}` : `item:${item.id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()];
  }, [props.backups, needle]);
  const totalBytes = props.backups.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  const originals = props.backups.filter((item) => item.protected).length;
  return <section className="panel"><div className="panelHeader"><div><span className="eyebrow">Safety net</span><h2>Configuration backups</h2><p>Every managed write preserves the previous file. Originals are what deactivating a profile restores; cleanup never deletes them.</p></div></div>
    <div className="statRow">
      <div><strong>{props.backups.length}</strong><small>backups</small></div>
      <div><strong>{formatBytes(totalBytes)}</strong><small>on disk</small></div>
      <div><strong>{originals}</strong><small>protected originals</small></div>
    </div>
    <SearchBox value={query} onChange={(value) => { setQuery(value); setLimit(BACKUP_PAGE); }} placeholder="Filter by file path or reason…" />
    <div className="backupList">{entries.length ? entries.slice(0, limit).map(([key, items]) => { const item = items[0]; const grouped = Boolean(item.groupId) && items.length > 1; const isOriginal = items.some((entry) => entry.protected); return <div className="backupRow" key={key}><ArchiveRestore size={17} /><div><strong>{grouped ? `${item.reason} · ${items.length} files` : item.reason}{isOriginal && <span className="metaTag protected" title="Restored when a profile is deactivated. Never pruned."><ShieldCheck size={11} />Original</span>}</strong><small title={items.map((entry) => entry.sourcePath).join("\n")}>{grouped ? items.map((entry) => entry.sourcePath).join(" · ") : item.sourcePath}</small></div><time>{new Date(item.createdAt).toLocaleString()}</time><button className="secondaryBtn small" onClick={() => grouped ? props.onRestoreGroup(item.groupId!, items.length) : props.onRestore(item)}>Restore</button></div>; }) : <div className="emptyState">{needle ? "No backups match this filter." : "No backups yet."}</div>}</div>
    {entries.length > limit && <div className="listFooter"><span>Showing {limit} of {entries.length}</span><button className="secondaryBtn small" onClick={() => setLimit((value) => value + BACKUP_PAGE)}>Show more</button></div>}
  </section>;
}

function HealthView(props: {
  issues: DoctorIssue[] | null;
  loading: boolean;
  profiles: Profile[];
  capabilities: Capability[];
  onOpenProfile: (profile: Profile) => void;
  onOpenCapability: (item: Capability) => void;
  onOpenProject: (path: string) => void;
  onOpenUnused: () => void;
  onOpenBackups: () => void;
}) {
  if (props.issues === null) return <section className="panel"><div className="emptyState">{props.loading ? "Running checks…" : "The health checks could not run. Try Run checks again, or run caps doctor in a terminal."}</div></section>;
  const counts = { error: 0, warn: 0, info: 0 };
  for (const issue of props.issues) counts[issue.severity] += 1;
  const action = (issue: DoctorIssue) => {
    if (issue.code === "unused-capabilities") return <button className="secondaryBtn small" onClick={props.onOpenUnused}>View unused</button>;
    if (issue.code === "backups") return <button className="secondaryBtn small" onClick={props.onOpenBackups}>Clean up</button>;
    const profile = props.profiles.find((item) => item.id === issue.profileId);
    if (profile && !profile.system) return <button className="secondaryBtn small" onClick={() => props.onOpenProfile(profile)}>Edit {profile.name}</button>;
    const capability = props.capabilities.find((item) => item.id === issue.capabilityId);
    if (capability && capability.kind !== "installed-plugin") return <button className="secondaryBtn small" onClick={() => props.onOpenCapability(capability)}>Open {capability.name}</button>;
    if (issue.projectPath && issue.code !== "assignment-path-missing") return <button className="secondaryBtn small" onClick={() => props.onOpenProject(issue.projectPath!)}>Open project</button>;
    return null;
  };
  return <div className="healthLayout">
    <section className={`healthSummary ${counts.error ? "error" : counts.warn ? "warn" : "ok"}`}>
      <span className="healthIcon">{counts.error || counts.warn ? <TriangleAlert size={22} /> : <ShieldCheck size={22} />}</span>
      <div><h2>{counts.error ? "Some profiles will not work as expected" : counts.warn ? "Everything runs, with a few warnings" : "No problems found"}</h2><p>Capsule checks the catalog, profiles, and project assignments for broken references, missing commands, and drift. Nothing is changed by a check.</p></div>
      <div className="healthCounts">{(["error", "warn", "info"] as DoctorSeverity[]).map((severity) => <span key={severity} className={severity}><strong>{counts[severity]}</strong>{SEVERITY_META[severity].label}</span>)}</div>
    </section>
    {(["error", "warn", "info"] as DoctorSeverity[]).filter((severity) => counts[severity] > 0).map((severity) => { const Icon = SEVERITY_META[severity].icon; return <section className="panel healthGroup" key={severity}>
      <div className="panelHeader"><div><span className="eyebrow">{SEVERITY_META[severity].label}</span><h2>{counts[severity]} {severity === "info" ? (counts[severity] === 1 ? "suggestion" : "suggestions") : counts[severity] === 1 ? "issue" : "issues"}</h2></div></div>
      <div className="issueList">{props.issues!.filter((issue) => issue.severity === severity).map((issue, index) => <article className={`issueRow ${severity}`} key={`${issue.code}-${index}`}>
        <Icon size={17} />
        <div><span className="issueCode">{issue.code}</span><p>{issue.message}</p><HintLine hint={issue.hint} /></div>
        <div className="rowButtons">{action(issue)}</div>
      </article>)}</div>
    </section>; })}
  </div>;
}

function HintLine({ hint }: { hint: string }) {
  const [copied, setCopied] = useState(false);
  // Hints often embed a caps command; offer it as a one-click copy.
  const command = hint.match(/\bcaps [^,;()`]+/)?.[0].split(" or ")[0].replace(/[.\s]+$/, "");
  return <small className="hint">{hint}{command && <button aria-label="Copy command" title={`Copy: ${command}`} onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{copied ? <Check size={12} /> : <Copy size={12} />}</button>}</small>;
}

function CapabilityEditor(props: { item?: Capability; initialKind?: CapabilityKind; onClose: () => void; onSave: (draft: CapabilityDraft) => void }) {
  const [kind, setKind] = useState<CapabilityKind>(props.item?.kind ?? props.initialKind ?? "mcp");
  const [name, setName] = useState(props.item?.name ?? "");
  const [description, setDescription] = useState(props.item?.description ?? "");
  const [content, setContent] = useState(props.item?.content ?? "");
  const [config, setConfig] = useState(JSON.stringify(props.item?.config ?? defaultConfig(kind), null, 2));
  const [event, setEvent] = useState(props.item?.event ?? "PreToolUse");
  const [matcher, setMatcher] = useState(props.item?.matcher ?? "");
  const initialHandlers = props.item?.handlers ?? [{ type: "command", command: "./script.sh" }];
  const simpleHandler = simpleCommandHandler(initialHandlers);
  const [hookMode, setHookMode] = useState<"simple" | "json">(simpleHandler ? "simple" : "json");
  const [command, setCommand] = useState(simpleHandler?.command ?? "");
  const [timeout, setTimeoutValue] = useState(simpleHandler?.timeout === undefined ? "" : String(simpleHandler.timeout));
  const [handlers, setHandlers] = useState(JSON.stringify(initialHandlers, null, 2));
  const [formError, setFormError] = useState<string | null>(null);
  const extraFiles = Object.keys(props.item?.files ?? {});
  const hookHandlers = (): unknown[] => {
    if (hookMode === "json") return JSON.parse(handlers);
    return [{ type: "command", command: command.trim(), ...(timeout.trim() ? { timeout: Number(timeout) } : {}) }];
  };
  const save = () => {
    setFormError(null);
    try {
      const draft: CapabilityDraft = { kind, name, description };
      if (kind === "mcp") draft.config = JSON.parse(config);
      if (kind === "skill" || kind === "instruction") draft.content = content;
      if (kind === "hook") {
        if (hookMode === "simple" && !command.trim()) throw new Error("Enter the command the hook runs.");
        if (hookMode === "simple" && timeout.trim() && !(Number(timeout) > 0)) throw new Error("Timeout must be a positive number of seconds.");
        draft.event = event; draft.matcher = matcher; draft.handlers = hookHandlers();
      }
      props.onSave(draft);
    } catch (err) {
      setFormError(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : message(err));
    }
  };
  const switchHookMode = (next: "simple" | "json") => {
    setFormError(null);
    if (next === "json") { setHandlers(JSON.stringify(hookHandlers(), null, 2)); setHookMode("json"); return; }
    try {
      const parsed = simpleCommandHandler(JSON.parse(handlers));
      if (!parsed) { setFormError("The simple form edits one command handler. Keep using JSON for this hook."); return; }
      setCommand(parsed.command); setTimeoutValue(parsed.timeout === undefined ? "" : String(parsed.timeout)); setHookMode("simple");
    } catch (err) {
      setFormError(`Invalid JSON: ${message(err)}`);
    }
  };
  return <Drawer title={props.item ? "Edit capability" : "New capability"} onClose={props.onClose}>
    <label className="field"><span>Type</span><select disabled={Boolean(props.item)} value={kind} onChange={(e) => { const next = e.target.value as CapabilityKind; setKind(next); setConfig(JSON.stringify(defaultConfig(next), null, 2)); }}>{(["mcp", "custom-plugin", "skill", "hook", "instruction"] as CapabilityKind[]).map((value) => <option value={value} key={value}>{KIND_META[value].label}</option>)}</select></label>
    <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Capability name" /></label>
    <label className="field"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When and why this is useful" /></label>
    {props.item && isLinked(props.item) && <div className="inlineNote"><Link2 size={14} /><span>Linked to <code>{props.item.sourcePath}</code>. Use Sync sources in the catalog to pull later edits from that file; edits saved here are overwritten by the next sync.</span></div>}
    {kind === "mcp" && <label className="field"><span>MCP configuration</span><textarea className="codeArea" value={config} onChange={(e) => setConfig(e.target.value)} /></label>}
    {(kind === "skill" || kind === "instruction") && <label className="field"><span>{kind === "skill" ? "SKILL.md" : "Instruction markdown"}</span><textarea className="codeArea tall" value={content} onChange={(e) => setContent(e.target.value)} /></label>}
    {kind === "skill" && extraFiles.length > 0 && <div className="field"><span>Bundled files · {extraFiles.length}</span><div className="fileSummary">{extraFiles.map((file) => <code key={file}>{file}</code>)}</div></div>}
    {kind === "hook" && <>
      <label className="field"><span>Event</span><input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="PreToolUse" /></label>
      <label className="field"><span>Matcher (optional)</span><input value={matcher} onChange={(e) => setMatcher(e.target.value)} placeholder="Bash" /></label>
      <div className="fieldHeader"><span>Handler</span><div className="segmented small"><button className={hookMode === "simple" ? "active" : ""} onClick={() => switchHookMode("simple")}>Command</button><button className={hookMode === "json" ? "active" : ""} onClick={() => switchHookMode("json")}><Braces size={12} />JSON</button></div></div>
      {hookMode === "simple" ? <div className="hookFields">
        <label className="field"><span>Command</span><input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder='sh "$HOME/.claude/hooks/check.sh"' /></label>
        <label className="field"><span>Timeout (seconds)</span><input type="number" min={1} value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} placeholder="Default" /></label>
      </div> : <label className="field"><span>Handlers</span><textarea className="codeArea tall" value={handlers} onChange={(e) => setHandlers(e.target.value)} /></label>}
    </>}
    {formError && <div className="alert error"><CircleAlert size={17} /><span>{formError}</span></div>}
    <div className="drawerFooter"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" disabled={!name.trim()} onClick={save}><Save size={16} />Save</button></div>
  </Drawer>;
}

function ProfileEditor(props: { item?: Profile; capabilities: Capability[]; profiles: Profile[]; onClose: () => void; onSave: (draft: { name: string; description?: string; capabilityIds: string[]; extends: string[] }) => void }) {
  const [name, setName] = useState(props.item?.name ?? "");
  const [description, setDescription] = useState(props.item?.description ?? "");
  const [selected, setSelected] = useState<string[]>(props.item?.capabilityIds ?? []);
  const [parents, setParents] = useState<string[]>(props.item?.extends ?? []);
  // System profiles cannot be extended, and a profile cannot extend itself or
  // anything that already extends it (the server rejects the cycle as well).
  const descendants = useMemo(() => props.item ? descendantIds(props.item.id, props.profiles) : new Set<string>(), [props.item, props.profiles]);
  const parentCandidates = props.profiles.filter((profile) => !profile.system && profile.id !== props.item?.id && !descendants.has(profile.id));
  const toggleParent = (id: string) => setParents((values) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const inherited = useMemo(() => {
    const sources = new Map<string, string>();
    for (const id of parents) {
      const parent = props.profiles.find((profile) => profile.id === id);
      if (!parent) continue;
      for (const capabilityId of effectiveIds(parent)) if (!sources.has(capabilityId)) sources.set(capabilityId, parent.name);
    }
    return sources;
  }, [parents, props.profiles]);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<CapabilityKind | "all">("all");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const toggle = (id: string) => setSelected((values) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return props.capabilities.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (selectedOnly && !selected.includes(item.id) && !inherited.has(item.id)) return false;
      if (!needle) return true;
      return [item.name, item.description, KIND_META[item.kind].label, item.kind]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(needle));
    });
  }, [props.capabilities, kindFilter, query, selected, selectedOnly, inherited]);
  const kinds = (Object.keys(KIND_META) as CapabilityKind[]).filter((kind) => props.capabilities.some((item) => item.kind === kind));
  const total = new Set([...selected, ...inherited.keys()]).size;
  return <Drawer title={props.item ? "Edit profile" : "New profile"} onClose={props.onClose} wide>
    <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" /></label>
    <label className="field"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this profile is for" /></label>
    {parentCandidates.length > 0 && <section className="profileCapabilityPicker">
      <div className="profileCapabilityHeader"><div><strong>Extends</strong><small>Inherit every capability of these profiles, including what they inherit · {parents.length} selected</small></div></div>
      <div className="profileCapabilityFilters">{parentCandidates.map((profile) => <button key={profile.id} className={parents.includes(profile.id) ? "active" : ""} aria-pressed={parents.includes(profile.id)} onClick={() => toggleParent(profile.id)}><GitBranch size={11} />{profile.name}<span>{effectiveIds(profile).length}</span></button>)}</div>
    </section>}
    <section className="profileCapabilityPicker">
      <div className="profileCapabilityHeader"><div><strong>Capabilities</strong><small>{visible.length} of {props.capabilities.length} shown · {selected.length} own{inherited.size > 0 && ` · ${inherited.size} inherited`} · {total} total</small></div>{selected.length > 0 && <button onClick={() => setSelected([])}>Clear selection</button>}</div>
      <div className="capabilitySearchRow"><label><Search size={15} /><input aria-label="Search capabilities" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, type, or source…" />{query && <button aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}</label><button className={selectedOnly ? "active" : ""} aria-pressed={selectedOnly} onClick={() => setSelectedOnly((value) => !value)}><Check size={14} />Selected only</button></div>
      <div className="profileCapabilityFilters"><button className={kindFilter === "all" ? "active" : ""} onClick={() => setKindFilter("all")}>All <span>{props.capabilities.length}</span></button>{kinds.map((kind) => <button key={kind} className={kindFilter === kind ? "active" : ""} onClick={() => setKindFilter(kind)}>{KIND_META[kind].label}<span>{props.capabilities.filter((item) => item.kind === kind).length}</span></button>)}</div>
      <div className="selectionList profileSelectionList">{visible.length ? visible.map((item) => {
        const meta = KIND_META[item.kind]; const Icon = meta.icon;
        const isSelected = selected.includes(item.id);
        const via = inherited.get(item.id);
        // Inherited items are locked on; one already listed as its own can still be dropped.
        if (via && !isSelected) return <button className="selected inherited" key={item.id} disabled title={`Inherited from ${via}`}><span className={`kindIcon ${meta.color}`}><Icon size={16} /></span><span><strong>{item.name}</strong><small><span>{meta.label}</span> · inherited from {via}</small></span><span className="checkBox"><Lock size={12} /></span></button>;
        return <button className={isSelected ? "selected" : ""} key={item.id} onClick={() => toggle(item.id)}><span className={`kindIcon ${meta.color}`}><Icon size={16} /></span><span><strong>{item.name}</strong><small><span>{meta.label}</span>{via ? <> · also inherited from {via}</> : item.description && <> · {item.description}</>}</small></span><span className="checkBox">{isSelected && <Check size={14} />}</span></button>;
      }) : <div className="emptyState compact">No capabilities match these filters.</div>}</div>
    </section>
    <div className="drawerFooter"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" disabled={!name.trim()} onClick={() => props.onSave({ name, description, capabilityIds: selected, extends: parents })}><Save size={16} />Save profile</button></div>
  </Drawer>;
}

function ImportEditor(props: { candidates?: ImportCandidate[]; projectPath: string; onCandidates: (items: ImportCandidate[]) => void; onClose: () => void; onImport: (ids: string[], name: string) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("Work");
  useEffect(() => { if (!props.candidates) void scanImport(props.projectPath || undefined).then((items) => { props.onCandidates(items); setSelected(items.map((item) => item.id)); }); }, []);
  const items = props.candidates ?? [];
  return <Drawer title="Import current Claude setup" onClose={props.onClose} wide>
    <p className="drawerIntro">Choose the current MCP servers, plugins, skills, hooks, and instructions to add to the global catalog.</p>
    <label className="field"><span>Destination profile</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
    {!props.candidates ? <div className="loadingBlock"><Loader2 className="spin" />Scanning Claude configuration…</div> : <div className="selectionList importList">{items.map((item) => { const meta = KIND_META[item.kind]; const Icon = meta.icon; return <button className={selected.includes(item.id) ? "selected" : ""} key={item.id} onClick={() => setSelected((values) => values.includes(item.id) ? values.filter((id) => id !== item.id) : [...values, item.id])}><span className={`kindIcon ${meta.color}`}><Icon size={16} /></span><span><strong>{item.name}</strong><small>{item.sourcePath}</small></span><span className="checkBox">{selected.includes(item.id) && <Check size={14} />}</span></button>; })}</div>}
    <div className="drawerFooter"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" disabled={!selected.length || !name.trim()} onClick={() => props.onImport(selected, name)}><Import size={16} />Import {selected.length} items</button></div>
  </Drawer>;
}

function FolderImportEditor(props: {
  initialFolderPath: string;
  onClose: () => void;
  onImport: (ids: string[]) => void;
}) {
  const [folderPath, setFolderPath] = useState(props.initialFolderPath);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [includeGlobal, setIncludeGlobal] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setScanError(null);
    try {
      const items = await scanImportFolder(folderPath, includeGlobal);
      setCandidates(items);
      setSelected(items.map((item) => item.id));
    } catch (err) {
      setCandidates(null);
      setSelected([]);
      setScanError(message(err));
    } finally {
      setScanning(false);
    }
  };

  return <Drawer title="Scan capabilities folder" onClose={props.onClose} wide>
    <p className="drawerIntro">Scan the folder and its first-level project directories. Selected MCPs, skills, hooks, and instructions will be added only to the global Catalog. Profiles will not be created or changed. Installed plugins stay in the separate Sync plugins flow.</p>
    <div className="scanPathRow">
      <label className="field"><span>Folder to scan</span><input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="/Users/name/Code" /></label>
      <button className="secondaryBtn" disabled={!folderPath.trim() || scanning} onClick={() => void scan()}>{scanning ? <Loader2 className="spin" size={16} /> : <FolderSearch size={16} />}Scan</button>
    </div>
    <label className="toggleField"><input type="checkbox" checked={includeGlobal} onChange={(event) => setIncludeGlobal(event.target.checked)} /><span><strong>Include global capabilities</strong><small>Also scan global MCPs; Claude, Codex, and Agents skills; Claude hooks; and global CLAUDE.md / AGENTS.md instructions.</small></span></label>
    {scanError && <div className="alert error"><CircleAlert size={17} /><span>{scanError}</span></div>}
    {scanning ? <div className="loadingBlock"><Loader2 className="spin" />Scanning project configurations…</div> : candidates ? (
      candidates.length ? <>
        <div className="selectionSummary"><span>{candidates.length} found</span><button onClick={() => setSelected(selected.length === candidates.length ? [] : candidates.map((item) => item.id))}>{selected.length === candidates.length ? "Clear all" : "Select all"}</button></div>
        <div className="selectionList importList">{candidates.map((item) => { const meta = KIND_META[item.kind]; const Icon = meta.icon; return <button className={selected.includes(item.id) ? "selected" : ""} key={item.id} onClick={() => setSelected((values) => values.includes(item.id) ? values.filter((id) => id !== item.id) : [...values, item.id])}><span className={`kindIcon ${meta.color}`}><Icon size={16} /></span><span><strong>{item.name}</strong><small>{item.sourcePath}</small></span><span className="checkBox">{selected.includes(item.id) && <Check size={14} />}</span></button>; })}</div>
      </> : <div className="emptyState">No supported capabilities were found in this folder.</div>
    ) : <div className="emptyState">Enter a folder path and scan to preview capabilities before importing.</div>}
    <div className="drawerFooter"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" disabled={!selected.length || scanning} onClick={() => props.onImport(selected)}><Import size={16} />Import {selected.length} to Catalog</button></div>
  </Drawer>;
}

function PluginEditor(props: { state: Extract<Editor, { type: "plugin" }>; onChange: (state: Editor) => void; onClose: () => void; onSave: (file: string, content: string) => void; onCreate: () => void; onDelete: () => void; onValidate: () => void }) {
  const selectFile = async (file: string) => { const content = await getPluginFile(props.state.item.id, file); props.onChange({ ...props.state, selected: file, content }); };
  return <Drawer title={`Plugin · ${props.state.item.name}`} onClose={props.onClose} wide>
    <div className="pluginWorkspace"><div className="fileTree">{props.state.files.map((file) => <button className={props.state.selected === file ? "active" : ""} key={file} onClick={() => void selectFile(file)}><Code2 size={13} />{file}</button>)}</div><div className="fileEditor">{props.state.selected ? <><div className="fileTitle">{props.state.selected}</div><textarea className="codeArea pluginCode" value={props.state.content ?? ""} onChange={(e) => props.onChange({ ...props.state, content: e.target.value })} /></> : <div className="emptyState">Select a text file to edit.</div>}</div></div>
    <div className="drawerFooter"><button className="dangerBtn" disabled={!props.state.selected} onClick={props.onDelete}><Trash2 size={16} />Delete file</button><button className="secondaryBtn" onClick={props.onCreate}><Plus size={16} />New file</button><button className="secondaryBtn" onClick={props.onValidate}><Check size={16} />Validate</button><button className="primaryBtn" disabled={!props.state.selected} onClick={() => props.state.selected && props.onSave(props.state.selected, props.state.content ?? "")}><Save size={16} />Save file</button></div>
  </Drawer>;
}

function ApplyDialog(props: { state: Extract<Editor, { type: "apply" }>; onClose: () => void; onConfirm: () => void }) {
  const { preview } = props.state;
  useEscape(props.onClose);
  return <div className="modalBackdrop" onMouseDown={closeOnBackdrop(props.onClose)}><div className="modal" role="dialog" aria-modal="true"><span className="modalIcon"><CircleAlert /></span><h2>{preview.drifted ? "Managed files changed" : "Take ownership of local files?"}</h2><p>{preview.drifted ? "The project’s generated Claude files were edited outside Capsule. Continuing will replace them after creating a backup." : "Capsule will fully manage these project-local files. Their current contents are saved as the originals that Deactivate restores."}</p><div className="fileSummary"><code>{preview.settingsPath}</code><code>{preview.instructionsPath}</code></div>{preview.warnings.length > 0 && <ul className="warningList">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}<div className="buttonRow"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" onClick={props.onConfirm}>{props.state.action === "launch" ? <Play size={16} /> : <Save size={16} />}{props.state.action === "launch" ? "Apply and launch" : "Apply profile"}</button></div></div></div>;
}

function ConfirmDialog(props: { state: Confirmation; onClose: () => void; onConfirm: () => void }) {
  useEscape(props.onClose);
  return <div className="modalBackdrop" onMouseDown={closeOnBackdrop(props.onClose)}><div className="modal" role="alertdialog" aria-modal="true"><span className={`modalIcon ${props.state.danger ? "danger" : ""}`}>{props.state.danger ? <Trash2 /> : <RotateCcw />}</span><h2>{props.state.title}</h2><p>{props.state.body}</p><div className="buttonRow"><button className="secondaryBtn" autoFocus onClick={props.onClose}>Cancel</button><button className={props.state.danger ? "dangerBtn solid" : "primaryBtn"} onClick={props.onConfirm}>{props.state.confirmLabel}</button></div></div></div>;
}

const SYNC_LABEL: Record<CapabilitySyncResult["status"], string> = {
  updated: "Changed at source",
  unchanged: "Up to date",
  missing: "Source missing",
  unlinked: "Not linked",
  failed: "Failed"
};

function SyncDialog(props: { ids?: string[]; onClose: () => void; onApply: (ids: string[]) => void }) {
  const [results, setResults] = useState<CapabilitySyncResult[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => { void syncCapabilities(props.ids, true).then(setResults, (err) => setLoadError(message(err))); }, []);
  const changed = (results ?? []).filter((item) => item.status === "updated");
  const problems = (results ?? []).filter((item) => item.status === "missing" || item.status === "failed");
  const order: CapabilitySyncResult["status"][] = ["updated", "missing", "failed", "unlinked", "unchanged"];
  const sorted = [...(results ?? [])].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return <Drawer title="Sync from source" onClose={props.onClose} wide>
    <p className="drawerIntro">Skills and instructions imported from a file keep a snapshot in the catalog. This compares each snapshot with its source file and folder. Nothing changes until you apply.</p>
    {loadError && <div className="alert error"><CircleAlert size={17} /><span>{loadError}</span></div>}
    {!results && !loadError ? <div className="loadingBlock"><Loader2 className="spin" />Comparing with source files…</div> : results && <>
      <div className="selectionSummary"><span>{changed.length} changed · {problems.length} {problems.length === 1 ? "problem" : "problems"} · {results.length} checked</span></div>
      <div className="syncList">{sorted.map((item) => { const meta = KIND_META[item.kind]; const Icon = meta.icon; return <div className={`syncRow ${item.status}`} key={item.id}>
        <span className={`kindIcon ${meta.color}`}><Icon size={16} /></span>
        <div><strong>{item.name}</strong><small title={item.sourcePath}>{item.sourcePath ?? "No source path"}</small>
          {item.changes.length > 0 && <span className="rowMeta">{item.changes.map((change) => <span className="metaTag" key={change}>{change}</span>)}</span>}
          {[item.error, ...item.warnings].filter(Boolean).map((text) => <small className="syncNote" key={text}>{text}</small>)}
        </div>
        <span className={`syncStatus ${item.status}`}>{SYNC_LABEL[item.status]}</span>
      </div>; })}</div>
    </>}
    <div className="drawerFooter"><button className="secondaryBtn" onClick={props.onClose}>Close</button><button className="primaryBtn" disabled={!changed.length} onClick={() => props.onApply(changed.map((item) => item.id))}><RefreshCw size={16} />{!results ? "Apply updates" : changed.length ? `Apply ${changed.length} ${changed.length === 1 ? "update" : "updates"}` : "Everything is up to date"}</button></div>
  </Drawer>;
}

function PruneDialog(props: { onClose: () => void; onConfirm: (options: { keep: number; olderThanDays?: number }, preview: PruneBackupsResult) => void }) {
  const [keep, setKeep] = useState("20");
  const [olderThan, setOlderThan] = useState("");
  const [preview, setPreview] = useState<PruneBackupsResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const keepValue = Number(keep);
  const olderValue = olderThan.trim() ? Number(olderThan) : undefined;
  const valid = keep.trim() !== "" && Number.isInteger(keepValue) && keepValue >= 0 && (olderValue === undefined || olderValue >= 0);
  useEffect(() => {
    if (!valid) { setPreview(null); return; }
    let current = true;
    const timer = setTimeout(() => {
      void pruneBackups({ keep: keepValue, olderThanDays: olderValue, dryRun: true }).then(
        (result) => { if (current) { setPreview(result); setPreviewError(null); } },
        (err) => { if (current) setPreviewError(message(err)); }
      );
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [keep, olderThan]);
  useEscape(props.onClose);
  return <div className="modalBackdrop" onMouseDown={closeOnBackdrop(props.onClose)}><div className="modal wide" role="dialog" aria-modal="true"><span className="modalIcon"><ArchiveRestore /></span><h2>Clean up old backups</h2><p>Keeps the newest backups of every file and deletes the rest. Originals that Deactivate restores are never deleted.</p>
    <div className="pruneFields">
      <label className="field"><span>Keep per file</span><input type="number" min={0} value={keep} onChange={(event) => setKeep(event.target.value)} /></label>
      <label className="field"><span>Only older than (days)</span><input type="number" min={0} value={olderThan} onChange={(event) => setOlderThan(event.target.value)} placeholder="Any age" /></label>
    </div>
    {previewError ? <div className="alert error"><CircleAlert size={17} /><span>{previewError}</span></div> : !valid ? <div className="alert error"><CircleAlert size={17} /><span>Enter whole numbers of zero or more.</span></div> : preview ? <div className="prunePreview">
      <div><strong>{preview.deletedCount}</strong><small>to delete</small></div>
      <div><strong>{formatBytes(preview.bytesFreed)}</strong><small>freed</small></div>
      <div><strong>{preview.keptCount}</strong><small>kept</small></div>
      <div><strong>{preview.protectedCount}</strong><small>protected</small></div>
    </div> : <div className="loadingBlock compact"><Loader2 className="spin" />Calculating…</div>}
    {preview && preview.splitGroups.length > 0 && <p className="warnText small">{preview.splitGroups.length} backup {preview.splitGroups.length === 1 ? "set loses" : "sets lose"} some files; restoring such a set brings back only the files that remain.</p>}
    <div className="buttonRow"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="dangerBtn solid" disabled={!valid || !preview || preview.deletedCount === 0} onClick={() => preview && props.onConfirm({ keep: keepValue, olderThanDays: olderValue }, preview)}><Trash2 size={16} />{preview?.deletedCount ? `Delete ${preview.deletedCount} backups` : "Nothing to delete"}</button></div>
  </div></div>;
}

function SearchBox(props: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="searchBox"><Search size={15} /><input aria-label="Search" value={props.value} onChange={(event) => props.onChange(event.target.value)} placeholder={props.placeholder} />{props.value && <button aria-label="Clear search" onClick={() => props.onChange("")}><X size={14} /></button>}</label>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}
function closeOnBackdrop(onClose: () => void) { return (event: React.MouseEvent) => { if (event.target === event.currentTarget) onClose(); }; }
function Drawer(props: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) { useEscape(props.onClose); return <div className="drawerBackdrop" onMouseDown={closeOnBackdrop(props.onClose)}><aside className={`profileDrawer ${props.wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={props.title}><header><div><span className="eyebrow">Capsule</span><h2>{props.title}</h2></div><button className="iconBtn" aria-label="Close" onClick={props.onClose}><X size={18} /></button></header><div className="drawerBody">{props.children}</div></aside></div>; }
function NavButton(props: { active: boolean; icon: typeof Plug; onClick: () => void; badge?: { count: number; tone: "error" | "warn" }; children: React.ReactNode }) { const Icon = props.icon; return <button className={props.active ? "active" : ""} onClick={props.onClick}><Icon size={18} />{props.children}{props.badge && <span className={`navBadge ${props.badge.tone}`}>{props.badge.count}</span>}</button>; }
function KindChip({ item, inherited }: { item: Capability; inherited?: string }) { const meta = KIND_META[item.kind]; const Icon = meta.icon; return <span className={`kindChip ${meta.color} ${inherited ? "inherited" : ""}`} title={inherited && inherited !== "parent" ? `Inherited from ${inherited}` : inherited ? "Inherited" : undefined}><Icon size={12} />{item.name}</span>; }
function titleFor(view: View) { return ({ projects: "Project profiles", profiles: "Profile catalog", catalog: "Capability catalog", backups: "Backup history", health: "Setup health" } as const)[view]; }

function capabilityHint(kind: CapabilityKind): string {
  return ({
    mcp: "Connect a local or remote MCP server",
    skill: "Store a reusable SKILL.md workflow",
    hook: "Run a handler on a Claude event",
    instruction: "Add reusable CLAUDE.md guidance",
    "custom-plugin": "Edit a managed plugin workspace",
    "installed-plugin": "Synced from Claude Code"
  } as const)[kind];
}
function defaultConfig(kind: CapabilityKind) { return kind === "mcp" ? { type: "stdio", command: "npx", args: ["-y", "your-mcp-package"] } : {}; }
function defaultScanFolder(projects: ProjectEntry[], projectPath: string): string {
  const sample = projects[0]?.path || projectPath;
  return sample ? sample.replace(/[\\/][^\\/]+[\\/]?$/, "") : "";
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function openPrimaryEditor(view: View, setEditor: (value: Editor | null) => void) { if (view === "profiles") setEditor({ type: "profile" }); else if (view === "catalog") setEditor({ type: "capability" }); else if (view === "projects") setEditor({ type: "import" }); else if (view === "backups") setEditor({ type: "prune" }); }

function effectiveIds(profile?: Profile): string[] { return profile ? profile.effectiveCapabilityIds ?? profile.capabilityIds : []; }
function profileSummary(profile: Profile): string {
  const total = effectiveIds(profile).length;
  const inherited = total - profile.capabilityIds.filter((id) => effectiveIds(profile).includes(id)).length;
  if (profile.system) return "Safe mode";
  return inherited > 0 ? `${total} capabilities · ${inherited} inherited` : `${total} capabilities`;
}
/** Capability id -> name of the first parent it comes from, for capabilities the profile does not list itself. */
function inheritedSources(profile: Profile, profiles: Profile[]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const parentId of profile.extends ?? []) {
    const parent = profiles.find((item) => item.id === parentId);
    if (!parent) continue;
    for (const id of effectiveIds(parent)) if (!profile.capabilityIds.includes(id) && !sources.has(id)) sources.set(id, parent.name);
  }
  return sources;
}
function descendantIds(id: string, profiles: Profile[]): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const current = queue.shift()!;
    for (const profile of profiles) {
      if (profile.extends?.includes(current) && !found.has(profile.id)) { found.add(profile.id); queue.push(profile.id); }
    }
  }
  return found;
}
/** Assigned projects can live outside the projects folder; list them too so they stay reachable. */
function mergeProjects(projects: ProjectEntry[], assignments: ProfileOverview["assignments"]): ProjectEntry[] {
  const known = new Set(projects.map((project) => project.path));
  const extra = assignments
    .filter((item) => !known.has(item.projectPath))
    .map((item) => ({ name: item.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? item.projectPath, path: item.projectPath }));
  return [...projects, ...extra.sort((a, b) => a.name.localeCompare(b.name))];
}
function isLinked(item: Capability): boolean { return (item.kind === "skill" || item.kind === "instruction") && Boolean(item.sourcePath); }
function healthTone(issues: DoctorIssue[] | null): string {
  if (issues === null) return "unknown";
  if (issues.some((issue) => issue.severity === "error")) return "error";
  return issues.some((issue) => issue.severity === "warn") ? "warn" : "";
}
/** The single plain command handler the simple hook form can edit without losing fields, if that is all there is. */
function simpleCommandHandler(handlers: unknown): { command: string; timeout?: number } | undefined {
  if (!Array.isArray(handlers) || handlers.length !== 1) return undefined;
  const handler = handlers[0] as Record<string, unknown>;
  if (!handler || handler.type !== "command" || typeof handler.command !== "string") return undefined;
  if (Object.keys(handler).some((key) => !["type", "command", "timeout"].includes(key))) return undefined;
  if (handler.timeout !== undefined && typeof handler.timeout !== "number") return undefined;
  return { command: handler.command, timeout: handler.timeout as number | undefined };
}
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
