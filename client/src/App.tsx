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
  Import,
  Loader2,
  Package,
  Play,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Sparkles,
  Trash2,
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
  getPluginFile,
  getPluginFiles,
  getProfileOverview,
  getProjects,
  launchProfile,
  previewProfile,
  removeCapability,
  removePluginFile,
  removeProfile,
  restoreBackup,
  restoreBackupGroup,
  savePluginFile,
  scanImport,
  scanImportFolder,
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
  ImportCandidate,
  Profile,
  ProfileOverview,
  ProjectEntry
} from "./types";

type View = "projects" | "profiles" | "catalog" | "backups";
type Editor =
  | { type: "capability"; item?: Capability; kind?: CapabilityKind }
  | { type: "profile"; item?: Profile }
  | { type: "import"; candidates?: ImportCandidate[] }
  | { type: "folder-import"; folderPath: string }
  | { type: "plugin"; item: Capability; files: string[]; selected?: string; content?: string }
  | { type: "apply"; preview: ApplyPreview; action: "apply" | "launch" };

const KIND_META: Record<CapabilityKind, { label: string; icon: typeof Plug; color: string }> = {
  mcp: { label: "MCP server", icon: Plug, color: "blue" },
  "installed-plugin": { label: "Installed plugin", icon: Package, color: "purple" },
  "custom-plugin": { label: "Custom plugin", icon: Code2, color: "indigo" },
  skill: { label: "Skill", icon: Sparkles, color: "amber" },
  hook: { label: "Hook", icon: Webhook, color: "teal" },
  instruction: { label: "Instruction", icon: FileText, color: "rose" }
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
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async (nextProjectPath = projectPath) => {
    setLoading(true);
    setError(null);
    try {
      const [nextProjects, nextOverview, nextBackups] = await Promise.all([
        getProjects(),
        getProfileOverview(nextProjectPath || undefined),
        getBackups()
      ]);
      setProjects(nextProjects);
      setOverview(nextOverview);
      setBackups(nextBackups);
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

  const prepareApply = async (profileId: string, action: "apply" | "launch") => {
    if (!projectPath) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await previewProfile(profileId, projectPath);
      if (preview.needsOwnershipConfirmation || preview.drifted) {
        setEditor({ type: "apply", preview, action });
      } else {
        await performApply(preview, action, false);
      }
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const performApply = async (preview: ApplyPreview, action: "apply" | "launch", force: boolean) => {
    await run(async () => {
      if (action === "launch") {
        const result = await launchProfile(preview.profile.id, preview.projectPath, {
          confirmOwnership: true,
          force
        });
        if (!result.launched) {
          await navigator.clipboard?.writeText(result.command);
          setNotice("Ghostty could not be opened. The launch command was copied.");
        } else {
          setNotice("Claude launched in Ghostty.");
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

  return (
    <div className="profileApp">
      <aside className="sidebar">
        <div className="logo">
          <span><Bot size={20} /></span>
          <div><strong>Capsule</strong><small>for Claude Code</small></div>
        </div>
        <nav>
          <NavButton active={view === "projects"} icon={FolderGit2} onClick={() => setView("projects")}>Projects</NavButton>
          <NavButton active={view === "profiles"} icon={Settings2} onClick={() => setView("profiles")}>Profiles</NavButton>
          <NavButton active={view === "catalog"} icon={Blocks} onClick={() => setView("catalog")}>Catalog</NavButton>
          <NavButton active={view === "backups"} icon={ArchiveRestore} onClick={() => setView("backups")}>Backups</NavButton>
        </nav>
        <div className="sidebarFooter">
          <span className="statusDot" /> Local only
          <small>{overview.capabilities.length} capabilities</small>
        </div>
      </aside>

      <div className="workspace">
        <header className="workspaceHeader">
          <div>
            <span className="kicker">{view}</span>
            <h1>{titleFor(view)}</h1>
          </div>
          <div className="headerActions">
            <button className="iconBtn" aria-label="Refresh" onClick={() => void load()}>
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
              </>
            )}
            <button className="primaryBtn" onClick={() => void openPrimaryEditor(view, setEditor, projectPath)}>
              {view === "projects" ? <Import size={16} /> : <Plus size={16} />}
              {view === "projects" ? "Import setup" : view === "profiles" ? "New profile" : view === "catalog" ? "New capability" : "Refresh"}
            </button>
          </div>
        </header>

        {error && <div className="alert error"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError(null)}><X size={15} /></button></div>}
        {notice && <div className="alert success"><Check size={17} /><span>{notice}</span><button onClick={() => setNotice(null)}><X size={15} /></button></div>}

        {view === "projects" && (
          <ProjectsView
            projects={projects}
            projectPath={projectPath}
            onProjectChange={setProjectPath}
            profiles={overview.profiles}
            assignment={assignment}
            assignedProfile={assignedProfile}
            capabilities={overview.capabilities}
            busy={busy}
            onApply={prepareApply}
            onOpenCatalog={() => setView("catalog")}
            onDeactivate={() => void run(() => deactivateProfile(projectPath), "Profile deactivated and original files restored.")}
          />
        )}
        {view === "profiles" && (
          <ProfilesView
            profiles={overview.profiles}
            capabilities={overview.capabilities}
            assignments={overview.assignments}
            onEdit={(item) => setEditor({ type: "profile", item })}
            onDelete={(item) => void run(() => removeProfile(item.id), "Profile deleted.")}
          />
        )}
        {view === "catalog" && (
          <CatalogView
            capabilities={overview.capabilities}
            onAdd={(kind) => setEditor({ type: "capability", kind })}
            onEdit={async (item) => {
              if (item.kind === "custom-plugin") {
                const files = await getPluginFiles(item.id);
                setEditor({ type: "plugin", item, files });
              } else if (item.kind !== "installed-plugin") {
                const raw = await getCapability(item.id, true);
                setEditor({ type: "capability", item: raw });
              }
            }}
            onFork={(item) => void run(async () => { await forkPlugin(item.id); }, "Editable plugin copy created.")}
            onDelete={(item) => void run(() => removeCapability(item.id), "Capability deleted.")}
          />
        )}
        {view === "backups" && (
          <BackupsView backups={backups} onRestore={(backup) => void run(() => restoreBackup(backup.id), "Backup restored.")} onRestoreGroup={(groupId) => void run(() => restoreBackupGroup(groupId), "Backup set restored.")} />
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
          onConfirm={() => void performApply(editor.preview, editor.action, editor.preview.drifted)}
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
  assignment?: ProfileOverview["assignments"][number];
  assignedProfile?: Profile;
  capabilities: Capability[];
  busy: boolean;
  onApply: (profileId: string, action: "apply" | "launch") => void;
  onOpenCatalog: () => void;
  onDeactivate: () => void;
}) {
  const [selected, setSelected] = useState(props.assignment?.profileId ?? props.profiles[0]?.id ?? "");
  useEffect(() => setSelected(props.assignment?.profileId ?? props.profiles[0]?.id ?? ""), [props.assignment?.profileId, props.profiles]);
  const profile = props.profiles.find((item) => item.id === selected);
  const selectedCapabilities = props.capabilities.filter((item) => profile?.capabilityIds.includes(item.id));
  return (
    <div className="pageGrid projectsGrid">
      <section className="workflowGuide">
        <div><span>1</span><strong>Add capabilities</strong><small>Create MCPs, skills, hooks, and instructions in Catalog.</small></div>
        <ChevronRight size={17} />
        <div><span>2</span><strong>Build a profile</strong><small>Choose which catalog items belong together.</small></div>
        <ChevronRight size={17} />
        <div><span>3</span><strong>Apply or launch</strong><small>Reuse that profile in any project.</small></div>
        <button className="secondaryBtn small" onClick={props.onOpenCatalog}>Open Catalog</button>
      </section>
      <section className="panel projectPickerPanel">
        <div className="panelHeader"><div><span className="eyebrow">Repository</span><h2>Choose a project</h2></div></div>
        <label className="field"><span>Project directory</span><select value={props.projectPath} onChange={(event) => props.onProjectChange(event.target.value)}>
          <option value="">Select a project</option>
          {props.projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}
        </select></label>
        <div className="pathBox"><FolderGit2 size={18} /><code>{props.projectPath || "No project selected"}</code></div>
        {props.assignment ? (
          <div className={`assignmentStatus ${props.assignment.state}`}>
            <span className="statusDot" /><div><strong>{props.assignedProfile?.name ?? "Unknown profile"}</strong><small>{props.assignment.state}</small></div>
          </div>
        ) : <div className="emptyState compact">No profile is assigned to this project.</div>}
      </section>

      <section className="panel profileChooser">
        <div className="panelHeader"><div><span className="eyebrow">Profile catalog</span><h2>Apply anywhere</h2><p>Profiles are global; the generated Claude files are project-local.</p></div></div>
        <div className="profileOptions">
          {props.profiles.map((item) => (
            <button key={item.id} className={`profileOption ${selected === item.id ? "selected" : ""}`} onClick={() => setSelected(item.id)}>
              <span className="profileGlyph">{item.system ? <Sparkles size={18} /> : <Settings2 size={18} />}</span>
              <span><strong>{item.name}</strong><small>{item.description || `${item.capabilityIds.length} capabilities`}</small></span>
              {selected === item.id && <Check size={17} />}
            </button>
          ))}
        </div>
        <div className="capabilityPreview">
          <span>Resolved capabilities</span>
          <div className="chips">{selectedCapabilities.length ? selectedCapabilities.map((item) => <KindChip key={item.id} item={item} />) : <small>None — clean Claude Code</small>}</div>
        </div>
        <div className="buttonRow">
          {props.assignment && <button className="dangerBtn" onClick={props.onDeactivate}><Power size={16} />Deactivate</button>}
          <button className="secondaryBtn" disabled={!selected || !props.projectPath || props.busy} onClick={() => props.onApply(selected, "apply")}><Save size={16} />Apply</button>
          <button className="primaryBtn" disabled={!selected || !props.projectPath || props.busy} onClick={() => props.onApply(selected, "launch")}><Play size={16} />Launch in Ghostty</button>
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
    const items = props.capabilities.filter((item) => profile.capabilityIds.includes(item.id));
    const projectCount = props.assignments.filter((item) => item.profileId === profile.id).length;
    return <article className="profileCard" key={profile.id}>
      <div className="cardTop"><span className={`largeGlyph ${profile.system ? "vanilla" : ""}`}>{profile.system ? <Sparkles /> : <Settings2 />}</span><div className="cardActions">
        {!profile.system && <button className="iconBtn" onClick={() => props.onEdit(profile)}><Settings2 size={15} /></button>}
        {!profile.system && <button className="iconBtn danger" onClick={() => props.onDelete(profile)}><Trash2 size={15} /></button>}
      </div></div>
      <h3>{profile.name}</h3><p>{profile.description || "No description"}</p>
      <div className="chips">{items.slice(0, 5).map((item) => <KindChip key={item.id} item={item} />)}{items.length > 5 && <span className="moreChip">+{items.length - 5}</span>}</div>
      <footer><span>{items.length} capabilities</span><span>{projectCount} projects</span></footer>
    </article>;
  })}</div>;
}

function CatalogView(props: {
  capabilities: Capability[];
  onAdd: (kind: CapabilityKind) => void;
  onEdit: (item: Capability) => void;
  onFork: (item: Capability) => void;
  onDelete: (item: Capability) => void;
}) {
  const [filter, setFilter] = useState<CapabilityKind | "all">("all");
  const items = props.capabilities.filter((item) => filter === "all" || item.kind === filter);
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
    <div className="filterBar"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All <span>{props.capabilities.length}</span></button>
      {(Object.keys(KIND_META) as CapabilityKind[]).map((kind) => <button key={kind} className={filter === kind ? "active" : ""} onClick={() => setFilter(kind)}>{KIND_META[kind].label}<span>{props.capabilities.filter((item) => item.kind === kind).length}</span></button>)}
    </div>
    <div className="catalogList">{items.length ? items.map((item) => {
      const meta = KIND_META[item.kind]; const Icon = meta.icon;
      return <article className="catalogRow" key={item.id}><span className={`kindIcon ${meta.color}`}><Icon size={18} /></span><div className="catalogIdentity"><strong>{item.name}</strong><small>{item.description || meta.label}</small></div><span className="kindLabel">{meta.label}</span><div className="rowButtons">
        {item.kind === "installed-plugin" && <button className="secondaryBtn small" onClick={() => props.onFork(item)}><Copy size={14} />Custom copy</button>}
        {item.kind !== "installed-plugin" && <button className="iconBtn" onClick={() => props.onEdit(item)}><ChevronRight size={16} /></button>}
        {item.kind !== "installed-plugin" && <button className="iconBtn danger" onClick={() => props.onDelete(item)}><Trash2 size={15} /></button>}
      </div></article>;
    }) : <div className="emptyState">No capabilities in this category. Use an Add button above to create one.</div>}</div>
  </div>;
}

function BackupsView(props: { backups: BackupEntry[]; onRestore: (item: BackupEntry) => void; onRestoreGroup: (groupId: string) => void }) {
  const entries = useMemo(() => {
    const groups = new Map<string, BackupEntry[]>();
    for (const item of props.backups) {
      const key = item.groupId ? `group:${item.groupId}` : `item:${item.id}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return [...groups.entries()];
  }, [props.backups]);
  return <section className="panel"><div className="panelHeader"><div><span className="eyebrow">Safety net</span><h2>Configuration backups</h2><p>Every managed write preserves the previous file.</p></div></div>
    <div className="backupList">{entries.length ? entries.map(([key, items]) => { const item = items[0]; const grouped = Boolean(item.groupId); return <div className="backupRow" key={key}><ArchiveRestore size={17} /><div><strong>{grouped ? `${item.reason} · ${items.length} files` : item.reason}</strong><small>{grouped ? items.map((entry) => entry.sourcePath).join(" · ") : item.sourcePath}</small></div><time>{new Date(item.createdAt).toLocaleString()}</time><button className="secondaryBtn small" onClick={() => grouped ? props.onRestoreGroup(item.groupId!) : props.onRestore(item)}>Restore</button></div>; }) : <div className="emptyState">No backups yet.</div>}</div>
  </section>;
}

function CapabilityEditor(props: { item?: Capability; initialKind?: CapabilityKind; onClose: () => void; onSave: (draft: CapabilityDraft) => void }) {
  const [kind, setKind] = useState<CapabilityKind>(props.item?.kind ?? props.initialKind ?? "mcp");
  const [name, setName] = useState(props.item?.name ?? "");
  const [description, setDescription] = useState(props.item?.description ?? "");
  const [content, setContent] = useState(props.item?.content ?? "");
  const [config, setConfig] = useState(JSON.stringify(props.item?.config ?? defaultConfig(kind), null, 2));
  const [event, setEvent] = useState(props.item?.event ?? "PreToolUse");
  const [matcher, setMatcher] = useState(props.item?.matcher ?? "");
  const [handlers, setHandlers] = useState(JSON.stringify(props.item?.handlers ?? [{ type: "command", command: "./script.sh" }], null, 2));
  const save = () => {
    const draft: CapabilityDraft = { kind, name, description };
    if (kind === "mcp") draft.config = JSON.parse(config);
    if (kind === "skill" || kind === "instruction") draft.content = content;
    if (kind === "hook") { draft.event = event; draft.matcher = matcher; draft.handlers = JSON.parse(handlers); }
    props.onSave(draft);
  };
  return <Drawer title={props.item ? "Edit capability" : "New capability"} onClose={props.onClose}>
    <label className="field"><span>Type</span><select disabled={Boolean(props.item)} value={kind} onChange={(e) => { const next = e.target.value as CapabilityKind; setKind(next); setConfig(JSON.stringify(defaultConfig(next), null, 2)); }}>{(["mcp", "custom-plugin", "skill", "hook", "instruction"] as CapabilityKind[]).map((value) => <option value={value} key={value}>{KIND_META[value].label}</option>)}</select></label>
    <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Capability name" /></label>
    <label className="field"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When and why this is useful" /></label>
    {kind === "mcp" && <label className="field"><span>MCP configuration</span><textarea className="codeArea" value={config} onChange={(e) => setConfig(e.target.value)} /></label>}
    {(kind === "skill" || kind === "instruction") && <label className="field"><span>{kind === "skill" ? "SKILL.md" : "Instruction markdown"}</span><textarea className="codeArea tall" value={content} onChange={(e) => setContent(e.target.value)} /></label>}
    {kind === "hook" && <><label className="field"><span>Event</span><input value={event} onChange={(e) => setEvent(e.target.value)} /></label><label className="field"><span>Matcher (optional)</span><input value={matcher} onChange={(e) => setMatcher(e.target.value)} /></label><label className="field"><span>Handlers</span><textarea className="codeArea tall" value={handlers} onChange={(e) => setHandlers(e.target.value)} /></label></>}
    <div className="drawerFooter"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" disabled={!name.trim()} onClick={save}><Save size={16} />Save</button></div>
  </Drawer>;
}

function ProfileEditor(props: { item?: Profile; capabilities: Capability[]; onClose: () => void; onSave: (draft: { name: string; description?: string; capabilityIds: string[] }) => void }) {
  const [name, setName] = useState(props.item?.name ?? "");
  const [description, setDescription] = useState(props.item?.description ?? "");
  const [selected, setSelected] = useState<string[]>(props.item?.capabilityIds ?? []);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<CapabilityKind | "all">("all");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const toggle = (id: string) => setSelected((values) => values.includes(id) ? values.filter((value) => value !== id) : [...values, id]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return props.capabilities.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (selectedOnly && !selected.includes(item.id)) return false;
      if (!needle) return true;
      return [item.name, item.description, KIND_META[item.kind].label, item.kind]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(needle));
    });
  }, [props.capabilities, kindFilter, query, selected, selectedOnly]);
  const kinds = (Object.keys(KIND_META) as CapabilityKind[]).filter((kind) => props.capabilities.some((item) => item.kind === kind));
  return <Drawer title={props.item ? "Edit profile" : "New profile"} onClose={props.onClose} wide>
    <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" /></label>
    <label className="field"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this profile is for" /></label>
    <section className="profileCapabilityPicker">
      <div className="profileCapabilityHeader"><div><strong>Capabilities</strong><small>{visible.length} of {props.capabilities.length} shown · {selected.length} selected</small></div>{selected.length > 0 && <button onClick={() => setSelected([])}>Clear selection</button>}</div>
      <div className="capabilitySearchRow"><label><Search size={15} /><input aria-label="Search capabilities" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, type, or source…" />{query && <button aria-label="Clear search" onClick={() => setQuery("")}><X size={14} /></button>}</label><button className={selectedOnly ? "active" : ""} aria-pressed={selectedOnly} onClick={() => setSelectedOnly((value) => !value)}><Check size={14} />Selected only</button></div>
      <div className="profileCapabilityFilters"><button className={kindFilter === "all" ? "active" : ""} onClick={() => setKindFilter("all")}>All <span>{props.capabilities.length}</span></button>{kinds.map((kind) => <button key={kind} className={kindFilter === kind ? "active" : ""} onClick={() => setKindFilter(kind)}>{KIND_META[kind].label}<span>{props.capabilities.filter((item) => item.kind === kind).length}</span></button>)}</div>
      <div className="selectionList profileSelectionList">{visible.length ? visible.map((item) => { const meta = KIND_META[item.kind]; const Icon = meta.icon; const isSelected = selected.includes(item.id); return <button className={isSelected ? "selected" : ""} key={item.id} onClick={() => toggle(item.id)}><span className={`kindIcon ${meta.color}`}><Icon size={16} /></span><span><strong>{item.name}</strong><small><span>{meta.label}</span>{item.description && <> · {item.description}</>}</small></span><span className="checkBox">{isSelected && <Check size={14} />}</span></button>; }) : <div className="emptyState compact">No capabilities match these filters.</div>}</div>
    </section>
    <div className="drawerFooter"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" disabled={!name.trim()} onClick={() => props.onSave({ name, description, capabilityIds: selected })}><Save size={16} />Save profile</button></div>
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
  return <div className="modalBackdrop"><div className="modal"><span className="modalIcon"><CircleAlert /></span><h2>{preview.drifted ? "Managed files changed" : "Take ownership of local files?"}</h2><p>{preview.drifted ? "The project’s generated Claude files were edited outside Capsule. Continuing will replace them after creating a backup." : "Capsule will fully manage these project-local files. Their current contents will be backed up first."}</p><div className="fileSummary"><code>{preview.settingsPath}</code><code>{preview.instructionsPath}</code></div><div className="buttonRow"><button className="secondaryBtn" onClick={props.onClose}>Cancel</button><button className="primaryBtn" onClick={props.onConfirm}>{props.state.action === "launch" ? <Play size={16} /> : <Save size={16} />}{props.state.action === "launch" ? "Apply and launch" : "Apply profile"}</button></div></div></div>;
}

function Drawer(props: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) { return <div className="drawerBackdrop"><aside className={`profileDrawer ${props.wide ? "wide" : ""}`}><header><div><span className="eyebrow">Capsule</span><h2>{props.title}</h2></div><button className="iconBtn" onClick={props.onClose}><X size={18} /></button></header><div className="drawerBody">{props.children}</div></aside></div>; }
function NavButton(props: { active: boolean; icon: typeof Plug; onClick: () => void; children: React.ReactNode }) { const Icon = props.icon; return <button className={props.active ? "active" : ""} onClick={props.onClick}><Icon size={18} />{props.children}</button>; }
function KindChip({ item }: { item: Capability }) { const meta = KIND_META[item.kind]; const Icon = meta.icon; return <span className={`kindChip ${meta.color}`}><Icon size={12} />{item.name}</span>; }
function titleFor(view: View) { return ({ projects: "Project profiles", profiles: "Profile catalog", catalog: "Capability catalog", backups: "Backup history" } as const)[view]; }

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
async function openPrimaryEditor(view: View, setEditor: (value: Editor | null) => void, _projectPath: string) { if (view === "profiles") setEditor({ type: "profile" }); else if (view === "catalog") setEditor({ type: "capability" }); else if (view === "projects") setEditor({ type: "import" }); }
