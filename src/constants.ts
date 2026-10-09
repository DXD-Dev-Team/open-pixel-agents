// ── Timing (ms) ──────────────────────────────────────────────
export const TOOL_DONE_DELAY_MS = 300;
export const PERMISSION_TIMER_DELAY_MS = 7000;
export const OFFICE_BRIDGE_READY_TIMEOUT_MS = 45_000;
export const OFFICE_SNAPSHOT_TIMEOUT_MS = 10_000;
export const OFFICE_SPEECH_DURATION_MS = 8_000;
export const OFFICE_SPEECH_MAX_LENGTH = 96;
export const OFFICE_ROLES = ['builder', 'security-reviewer', 'verifier', 'manager'] as const;
export const OFFICE_MANAGER_MODES = ['auto', 'human-approval'] as const;
export const OFFICE_AGENT_ACTIONS = ['open', 'send', 'start', 'stop', 'close', 'role', 'manager-mode', 'assign-team', 'approve', 'reject', 'attention', 'sign-in', 'change-account', 'add-account', 'manager-repos', 'manager-scope'] as const;
export const OFFICE_PANEL_CHAT_LIMIT = 50;
export const OFFICE_PANEL_TEAM_LIMIT = 100;
export const OFFICE_PANEL_TEXT_LIMIT = 20_000;
export const OFFICE_STATUS_PRECEDENCE = ['needs input', 'failed', 'working', 'reading', 'waiting', 'done', 'idle'] as const;
export const OFFICE_READING_TOOLS = ['read', 'grep', 'glob', 'webfetch', 'websearch', 'list', 'ls'] as const;

// ── Display Truncation ──────────────────────────────────────
export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── PNG / Asset Parsing ─────────────────────────────────────
export const PNG_ALPHA_THRESHOLD = 128;
export const WALL_PIECE_WIDTH = 16;
export const WALL_PIECE_HEIGHT = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;
export const FLOOR_PATTERN_COUNT = 7;
export const FLOOR_TILE_SIZE = 16;
export const CHARACTER_DIRECTIONS = ['down', 'up', 'right'] as const;
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
export const CHAR_COUNT = 6;

// ── User-Level Layout Persistence ─────────────────────────────
export const LAYOUT_FILE_DIR = '.office-pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;

// ── Settings Persistence ────────────────────────────────────
export const GLOBAL_KEY_SOUND_ENABLED = 'office-pixel-agents.soundEnabled';

// ── VS Code Identifiers ─────────────────────────────────────
export const VIEW_ID = 'office-pixel-agents.panelView';
export const COMMAND_SHOW_PANEL = 'office-pixel-agents.showPanel';
export const COMMAND_EXPORT_DEFAULT_LAYOUT = 'office-pixel-agents.exportDefaultLayout';
export const WORKSPACE_KEY_AGENTS = 'office-pixel-agents.agents';
export const WORKSPACE_KEY_AGENT_SEATS = 'office-pixel-agents.agentSeats';
export const WORKSPACE_KEY_LAYOUT = 'office-pixel-agents.layout';
export const WORKSPACE_KEY_OPENCODE_SERVER_PORT = 'office-pixel-agents.opencodeServerPort';
