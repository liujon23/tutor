// Shared types for the learning-tutor deterministic core.
// These mirror the document contract in skills/references/document-formats.md.

export type TopicState = "not-started" | "touched" | "comfortable" | "shaky";
export type UnitState = "not-started" | "in-progress" | "core-complete" | "complete";

export const TOPIC_STATES: TopicState[] = ["not-started", "touched", "comfortable", "shaky"];
export const UNIT_STATES: UnitState[] = ["not-started", "in-progress", "core-complete", "complete"];

export interface LastTouched {
  date: string; // YYYY-MM-DD
  lesson: number;
}

export type TopicAssetKind = "image" | "text" | "link";
export const TOPIC_ASSET_KINDS: TopicAssetKind[] = ["image", "text", "link"];

/**
 * A curated material for future lessons on this topic. `image` URLs must be
 * public-domain sources (the app embeds and caches them); `text`/`link` are
 * navigational and may point anywhere. Curated by course-setup editing the
 * YAML directly — there is no patch surface for assets.
 */
export interface TopicAsset {
  kind: TopicAssetKind;
  url: string;
  title: string;
  note?: string;
}

export interface Topic {
  id: string;
  name: string;
  state: TopicState;
  lastTouched: LastTouched | null;
  prerequisites: string[]; // topic ids, same unit only
  buildsToward: string[]; // topic ids, same unit only
  notes: string;
  assets?: TopicAsset[]; // normalized to [] on load
}

export interface Unit {
  id: string;
  name: string;
  state: UnitState;
  currentTopic: string | null;
  prerequisites: string[]; // unit ids
  bridgeTopics: string[]; // topic ids in OTHER units (suggestions, not dependencies)
  notes: string;
  coreTopics: Topic[];
  optionalTopics: Topic[];
}

export interface NextUp {
  // Exactly one target. `topicId` queues a concrete topic; `unitId` queues a
  // new unit whose topics aren't created yet (topic setup is course-setup's
  // job) — so a wrap-up at a unit boundary needn't anchor to a stale topic.
  topicId?: string;
  unitId?: string;
  plan: string; // one-line plan carried over from the previous wrap-up
}

export interface Lane {
  id: string;
  name: string;
  weight: number; // rough % of the learner's attention
  currentUnit: string | null;
  direction: string;
  nextUp: NextUp | null;
  units: Unit[];
}

export interface Curriculum {
  lanes: Lane[];
}

// ---------------------------------------------------------------------------
// Session patch — the structured diff the tutor emits at wrap-up.
// ---------------------------------------------------------------------------

export interface LessonRecord {
  date: string; // YYYY-MM-DD
  laneId: string;
  unitId: string;
  topicIds: string[]; // curriculum topic ids this lesson touched
  topicsFreeform?: string; // optional label when the lesson strayed off-graph
  whatHappened: string;
  performanceSketch: string;
  sourcesUsed: string;
  feedbackCaptured: string;
  askedAbout: string;
}

export interface TopicUpdate {
  id: string;
  state?: TopicState;
  notes?: string;
  touched?: boolean; // default true → lastTouched set from the lesson date/number
}

export interface UnitUpdate {
  id: string;
  state?: UnitState;
  currentTopic?: string | null;
  notes?: string;
}

export interface LaneUpdate {
  id: string;
  currentUnit?: string;
  direction?: string;
  nextUp?: NextUp | null; // null clears it
}

export interface NewTopicSpec {
  unitId: string;
  group: "core" | "optional";
  topic: {
    id: string;
    name: string;
    state?: TopicState;
    prerequisites?: string[];
    buildsToward?: string[];
    notes?: string;
  };
}

export interface NewUnitSpec {
  laneId: string;
  unit: {
    id: string;
    name: string;
    state?: UnitState;
    prerequisites?: string[];
    bridgeTopics?: string[];
    notes?: string;
  };
}

export interface BulletEdits {
  add?: string[];
  removeContaining?: string[];
}

export interface ProfilePatch {
  workingNotes?: BulletEdits;
  broaderPrerequisites?: BulletEdits;
  settledQuestions?: BulletEdits;
  /**
   * Proposed changes to CONFIRMED PATTERNS. NEVER applied by the patcher —
   * printed loudly for the learner to approve. You propose, they dispose.
   */
  proposedConfirmedPatterns?: string[];
  /**
   * Only include when the learner has explicitly agreed in-conversation. The patcher
   * applies these to the profile's confirmed-patterns section ("How I learn best").
   */
  approvedConfirmedPatterns?: BulletEdits;
}

/**
 * Whole-file replacement of a lane's project artifact (`data/projects/<laneId>.md`).
 * The design doc a project-bearing lane accretes across lessons — read into the
 * packet verbatim, rewritten in full at wrap-up (like a topic's `notes` or a lane's
 * `direction`, this is a replace, not a merge). Absent on lanes without a project.
 */
export interface ProjectUpdate {
  laneId: string;
  content: string; // full markdown; replaces data/projects/<laneId>.md
}

export interface SessionPatch {
  lesson: LessonRecord;
  curriculum?: {
    topicUpdates?: TopicUpdate[];
    unitUpdates?: UnitUpdate[];
    laneUpdates?: LaneUpdate[];
    newTopics?: NewTopicSpec[];
    newUnits?: NewUnitSpec[];
  };
  profile?: ProfilePatch;
  project?: ProjectUpdate;
}

// ---------------------------------------------------------------------------
// Session packet options
// ---------------------------------------------------------------------------

export type SessionSize = "tight" | "standard" | "deep";

export interface PacketOptions {
  laneId?: string; // omit → use the recommendation across lanes
  size: SessionSize;
  model: string; // "opus" | "sonnet" — echoed into the packet, enforced by the caller
  historyN: number; // how many recent lesson-history entries to include
  today: string; // YYYY-MM-DD
  staleDays: number; // recall-candidate threshold
}

export interface DataPaths {
  curriculum: string;
  profile: string;
  history: string;
  projectsDir: string; // dir of per-lane project docs: <projectsDir>/<laneId>.md
}
