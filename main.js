const { Plugin, Notice, PluginSettingTab, Setting, MarkdownView } = require('obsidian');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { ViewPlugin, Decoration, EditorView, WidgetType } = require('@codemirror/view');
const { RangeSetBuilder } = require('@codemirror/state');
const { autocompletion } = require('@codemirror/autocomplete');
const { syntaxTree } = require('@codemirror/language');

const DEFAULT_SETTINGS = {
	timeout: 120000,
	provider: 'claude', // 'claude', 'gemini', 'ollama', or 'codex' (for default @claude)
	responseStyle: 'callout', // 'blockquote', 'callout', 'plain', 'code', 'custom'
	customResponseFormat: '> **AI:** {response}', // Used when responseStyle is 'custom'. {response} is replaced with AI output
	ollamaBaseUrl: 'http://localhost:11434',
	// CLI paths
	nodePath: 'node', // Use system PATH, or specify absolute path (e.g., /usr/local/bin/node)
	claudeDirectExec: true, // Run claude binary directly (true) or via node (false, for older script-based installs)
	claudePath: 'claude',
	geminiPath: 'gemini',
	codexPath: 'codex',
	// API keys (alternative to CLI)
	claudeApiKey: '',  // Anthropic API key for direct API access
	openaiApiKey: '',  // OpenAI API key for direct API access
	geminiApiKey: '',  // Google AI API key for direct API access
	agents: [
		{
			alias: 'claude',
			provider: 'claude',
			connectionMode: 'cli',    // 'cli' or 'api' - how to connect to Claude
			systemPrompt: 'You are helping the user understand their notes in Obsidian. CRITICAL: Give EXTREMELY brief answers - 1-2 sentences MAX. No elaboration, no examples, no explanations unless explicitly requested with keywords like \'detailed\', \'explain\', \'elaborate\', \'examples\'. Be as terse as possible. Answer the question directly and stop.',
			includeAllWikilinks: false,
			deleteQueryAfterResponse: false, // Remove @agent query line after response is shown
			timeout: undefined,        // Optional: Override global timeout (ms)
			responseStyle: undefined,  // Optional: Override global response style
			model: undefined          // Optional: Specify model (e.g., 'claude-opus-4' for CLI, 'claude-sonnet-4-20250514' for API)
		},
		{
			alias: 'gemini',
			provider: 'gemini',
			connectionMode: 'cli',    // 'cli' or 'api' - how to connect to Gemini
			systemPrompt: 'You are helping the user understand their notes in Obsidian. CRITICAL: Give EXTREMELY brief answers - 1-2 sentences MAX. No elaboration, no examples, no explanations unless explicitly requested with keywords like \'detailed\', \'explain\', \'elaborate\', \'examples\'. Be as terse as possible. Answer the question directly and stop.',
			includeAllWikilinks: false,
			deleteQueryAfterResponse: false,
			timeout: undefined,
			responseStyle: undefined,
			model: undefined          // Optional: Specify model (e.g., 'gemini-2.0-flash-exp' for API)
		},
		{
			alias: 'ollama',
			provider: 'ollama',
			systemPrompt: 'You are helping the user understand their notes in Obsidian. CRITICAL: Give EXTREMELY brief answers - 1-2 sentences MAX. No elaboration, no examples, no explanations unless explicitly requested with keywords like \'detailed\', \'explain\', \'elaborate\', \'examples\'. Be as terse as possible. Answer the question directly and stop.',
			includeAllWikilinks: false,
			deleteQueryAfterResponse: false,
			timeout: undefined,
			responseStyle: undefined,
			model: 'llama2'           // Ollama model (e.g., 'llama3', 'mistral', 'codellama')
		},
		{
			alias: 'gpt',
			provider: 'codex',
			connectionMode: 'cli',    // 'cli' or 'api' - how to connect to OpenAI
			systemPrompt: 'You are helping the user understand their notes in Obsidian. CRITICAL: Give EXTREMELY brief answers - 1-2 sentences MAX. No elaboration, no examples, no explanations unless explicitly requested with keywords like \'detailed\', \'explain\', \'elaborate\', \'examples\'. Be as terse as possible. Answer the question directly and stop.',
			includeAllWikilinks: false,
			deleteQueryAfterResponse: false,
			timeout: undefined,
			responseStyle: undefined,
			model: 'gpt-4o'           // OpenAI model (e.g., 'gpt-4o', 'o1', 'gpt-4-turbo')
		},
		{
			alias: 'plot',
			provider: 'claude',
			connectionMode: 'cli',    // 'cli' or 'api' - how to connect to Claude
			plotLibrary: 'charts', // 'charts', 'desmos', 'functionplot'
			systemPrompt: '', // Auto-generated based on plotLibrary
			includeAllWikilinks: false,
			deleteQueryAfterResponse: false,
			timeout: 120000,
			responseStyle: 'plain',
			disableStreaming: true,
			model: undefined
		}
	]
};

// Plot library prompts - used to auto-generate system prompts for @plot agent
const PLOT_LIBRARY_PROMPTS = {
	charts: `You create interactive charts for Obsidian using the Charts plugin (Chart.js).

RESPOND WITH ONLY:
1. A chart code block (see format below)
2. A 1-2 sentence description

CHART CODE BLOCK FORMAT:
\`\`\`chart
type: scatter
labels: [1, 2, 3, 4, 5]
series:
  - title: Data Points
    data: [2.1, 4.2, 5.8, 8.1, 9.9]
  - title: Best Fit Line
    data: [2, 4, 6, 8, 10]
tension: 0
beginAtZero: true
\`\`\`

CHART TYPES: line, bar, scatter, pie, doughnut, radar, polarArea

OPTIONS:
- title: "Chart Title"
- tension: 0.4 (curved lines) or 0 (straight)
- beginAtZero: true
- legendPosition: top/bottom/left/right

FOR LINEAR REGRESSION:
- Use type: line (scatter doesn't connect points well)
- Generate 10-15 realistic data points with noise around a trend
- Add a second series for the regression line (calculated from the data)
- Use tension: 0 for the regression line series

FOR FUNCTIONS (sin, cos, polynomials):
- Use type: line with tension: 0.4 for smooth curves
- Generate 30+ points for smooth appearance

IMPORTANT: Output ONLY the raw chart code block and brief description. No markdown formatting around it, no extra explanation.`,

	desmos: `You create mathematical graphs for Obsidian using the Desmos plugin.

RESPOND WITH ONLY:
1. A desmos-graph code block (see format below)
2. A 1-2 sentence description

CODE BLOCK FORMAT:
\`\`\`desmos-graph
left=-10; right=10; top=10; bottom=-10;
---
y=x^2
y=2x+1
\`\`\`

SETTINGS (before the ---):
- left, right, top, bottom: graph boundaries
- height, width: dimensions in pixels (e.g., height=400; width=600;)
- grid=false: disable grid
- degreeMode=degrees or degreeMode=radians

EQUATION SYNTAX (LaTeX math format):
- Functions: y=\\sin(x), y=\\cos(x), y=\\tan(x), y=e^x, y=\\ln(x)
- Powers: y=x^2, y=x^{3}, y=\\sqrt{x}
- Fractions: y=\\frac{1}{x}
- Absolute value: y=|x|
- Implicit: x^2+y^2=25 (circle)
- Parametric: (\\cos(t), \\sin(t))
- Inequalities: y>x^2, y<2x+1
- Points: (2, 3)
- Vertical lines: x=5

STYLING (use | after equation):
- Colors: |red|, |blue|, |green|, |orange|, |purple|, |black|
- Styles: |dashed|, |dotted|, |solid|
- Restrictions: |y>0|, |x<5|

EXAMPLE with styling:
\`\`\`desmos-graph
left=-5; right=5; top=10; bottom=-2;
---
y=x^2|blue|
y=2x+1|red|dashed|
(0,0)|green|
\`\`\`

IMPORTANT:
- Use LaTeX syntax for math (\\sin, \\frac, ^{}, etc.)
- Each equation on its own line after ---
- Output ONLY the code block and brief description`,

	functionplot: `You create mathematical function plots for Obsidian using the Function Plot plugin.

RESPOND WITH ONLY:
1. A functionplot code block (see format below)
2. A 1-2 sentence description

CODE BLOCK FORMAT:
\`\`\`functionplot
---
title: Graph Title
xLabel: x
yLabel: y
bounds: [-10, 10, -10, 10]
grid: true
---
f(x)=x^2
g(x)=sin(x)
h(x)=2*x+1
\`\`\`

FRONTMATTER OPTIONS (between --- markers):
- title: Chart title
- xLabel, yLabel: Axis labels
- bounds: [xMin, xMax, yMin, yMax]
- grid: true/false
- disableZoom: true/false (1 or 0)

FUNCTION SYNTAX (MUST use name(x)=expression format):
- Basic: f(x)=x^2, g(x)=2*x+1
- Trig: f(x)=sin(x), f(x)=cos(x), f(x)=tan(x)
- Exponential: f(x)=E^x, f(x)=log(x)
- Constants: Use E for Euler's number, PI for pi
- Powers: f(x)=x^PI, f(x)=x^2
- Multiple functions: Use different names (f, g, h, etc.)

EXAMPLE:
\`\`\`functionplot
---
title: Quadratic vs Linear
xLabel: x
yLabel: y
bounds: [-5, 5, -5, 10]
grid: true
---
f(x)=x^2
g(x)=2*x+1
\`\`\`

IMPORTANT:
- ALWAYS use f(x)=, g(x)=, h(x)= format, NOT y=
- Output ONLY the code block and brief description`
};

// Map of plot library to required Obsidian plugin
const PLOT_LIBRARY_PLUGINS = {
	charts: 'Obsidian Charts',
	desmos: 'Desmos',
	functionplot: 'Function Plot'
};

// CodeMirror 6 ViewPlugin to decorate agent triggers as pills
function createAgentPillPlugin(agentsRef) {
	// Create provider-specific decorations
	const decorations = {
		claude: Decoration.mark({
			class: 'agent-pill agent-pill-claude',
			attributes: {
				style: 'background-color: #ff8c64; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.9em; font-weight: 500;'
			}
		}),
		gemini: Decoration.mark({
			class: 'agent-pill agent-pill-gemini',
			attributes: {
				style: 'background-color: #4285f4; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.9em; font-weight: 500;'
			}
		}),
		ollama: Decoration.mark({
			class: 'agent-pill agent-pill-ollama',
			attributes: {
				style: 'background-color: #8B7355; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.9em; font-weight: 500;'
			}
		}),
		codex: Decoration.mark({
			class: 'agent-pill agent-pill-codex',
			attributes: {
				style: 'background-color: #10b981; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.9em; font-weight: 500;'
			}
		}),
		default: Decoration.mark({
			class: 'agent-pill agent-pill-default',
			attributes: {
				style: 'background-color: #6b7280; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.9em; font-weight: 500;'
			}
		})
	};

	// Build agent patterns from the reference (will be rebuilt when agents change)
	function buildAgentPatterns() {
		return agentsRef.current.map(agent => ({
			regex: new RegExp(`@${agent.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'),
			decoration: decorations[agent.provider] || decorations.default
		}));
	}

	return ViewPlugin.fromClass(class {
		constructor(view) {
			this.agentPatterns = buildAgentPatterns();
			this.agentsVersion = agentsRef.version;
			this.decorations = this.buildDecorations(view);
			this.debounceTimer = null;
			this.pendingView = null;
		}

		update(update) {
			// Check if agents changed - rebuild patterns and decorations
			if (this.agentsVersion !== agentsRef.version) {
				this.agentPatterns = buildAgentPatterns();
				this.agentsVersion = agentsRef.version;
				this.decorations = this.buildDecorations(update.view);
				return;
			}

			// Always rebuild immediately on document changes (typing, edits)
			if (update.docChanged) {
				this.decorations = this.buildDecorations(update.view);
				return;
			}

			// Debounce viewport changes (scrolling) for better performance (optimization #3)
			if (update.viewportChanged) {
				this.pendingView = update.view;

				if (this.debounceTimer) {
					clearTimeout(this.debounceTimer);
				}

				this.debounceTimer = setTimeout(() => {
					if (this.pendingView) {
						this.decorations = this.buildDecorations(this.pendingView);
						this.pendingView = null;
					}
				}, 100); // 100ms debounce
			}
		}

		destroy() {
			if (this.debounceTimer) {
				clearTimeout(this.debounceTimer);
			}
		}

		buildDecorations(view) {
			// Collect all matches first, then sort by position
			const matches = [];

			for (let { from, to } of view.visibleRanges) {
				const text = view.state.doc.sliceString(from, to);

				for (const pattern of this.agentPatterns) {
					pattern.regex.lastIndex = 0;
					let match;

					while ((match = pattern.regex.exec(text)) !== null) {
						matches.push({
							start: from + match.index,
							end: from + match.index + match[0].length,
							decoration: pattern.decoration
						});
					}
				}
			}

			// Sort by start position (required by RangeSetBuilder)
			matches.sort((a, b) => a.start - b.start);

			// Build decorations in sorted order
			const builder = new RangeSetBuilder();
			for (const m of matches) {
				builder.add(m.start, m.end, m.decoration);
			}

			return builder.finish();
		}
	}, {
		decorations: v => v.decorations
	});
}

// CodeMirror 6 Autocomplete for all agents
function createAgentAutocomplete(agentsRef) {
	return autocompletion({
		override: [
			(context) => {
				const word = context.matchBefore(/@\w*/);
				if (!word) return null;
				if (word.from === word.to && !context.explicit) return null;

				// Filter agents based on what user has typed (always use current agents)
				const typed = word.text.toLowerCase();
				const matchingAgents = agentsRef.current.filter(agent =>
					`@${agent.alias}`.toLowerCase().startsWith(typed)
				);

				if (matchingAgents.length === 0) return null;

				return {
					from: word.from,
					options: matchingAgents.map(agent => {
						const emoji = agent.connectionMode === 'api' ? '🔑' : '💻';
						return {
							label: `${emoji} @${agent.alias}`,
							apply: `@${agent.alias} `,
							detail: agent.provider
						};
					})
				};
			}
		]
	});
}

// CSS styles for loading animation (injected once on plugin load)
const LOADING_ANIMATION_CSS = `
@keyframes hourglass-flip {
	0%, 45% { transform: rotate(0deg); }
	50%, 95% { transform: rotate(180deg); }
	100% { transform: rotate(360deg); }
}

@keyframes loading-pulse {
	0%, 100% { opacity: 1; }
	50% { opacity: 0.5; }
}

/* Edit mode: CodeMirror decorations */
.atline-ai-loading-hourglass {
	display: inline-block;
	animation: hourglass-flip 2s ease-in-out infinite;
}

.atline-ai-loading-text {
	animation: loading-pulse 1.5s ease-in-out infinite;
}

/* Reading mode: Rendered callouts with loading indicator */
.atline-ai-loading-callout .callout-content em {
	animation: loading-pulse 1.5s ease-in-out infinite;
}

.atline-ai-loading-callout .callout-content {
	/* Target text containing hourglass for flip animation */
}

/* Animate hourglass in rendered view via wrapper span */
.atline-ai-loading-emoji {
	display: inline-block;
	animation: hourglass-flip 2s ease-in-out infinite;
}
`;

// CodeMirror 6 ViewPlugin to animate loading indicators
function createLoadingAnimationPlugin() {
	// Create decorations for hourglass and text
	const hourglassDecoration = Decoration.mark({
		class: 'atline-ai-loading-hourglass'
	});

	const textDecoration = Decoration.mark({
		class: 'atline-ai-loading-text'
	});

	return ViewPlugin.fromClass(class {
		constructor(view) {
			this.decorations = this.buildDecorations(view);
		}

		update(update) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = this.buildDecorations(update.view);
			}
		}

		buildDecorations(view) {
			const builder = new RangeSetBuilder();

			// Only process visible ranges for performance
			for (const { from, to } of view.visibleRanges) {
				const text = view.state.doc.sliceString(from, to);

				// Find loading indicators: ⏳ *Provider is thinking...* <!-- marker -->
				const loadingRegex = /⏳ \*\w+ is thinking\.\.\.\* <!-- agent-[a-f0-9-]+ -->/g;
				let match;

				while ((match = loadingRegex.exec(text)) !== null) {
					const matchStart = from + match.index;

					// Decorate the hourglass emoji (first 2 characters: ⏳ is 1 char + space)
					builder.add(matchStart, matchStart + 1, hourglassDecoration);

					// Decorate the text portion (after hourglass+space, before the marker)
					const textStart = matchStart + 2; // After "⏳ "
					const markerIndex = match[0].indexOf(' <!-- ');
					const textEnd = matchStart + markerIndex;
					if (textEnd > textStart) {
						builder.add(textStart, textEnd, textDecoration);
					}
				}
			}

			return builder.finish();
		}
	}, {
		decorations: v => v.decorations
	});
}

function extractWikilinks(text) {
	const regex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
	const links = [];
	const seen = new Set();
	for (const match of text.matchAll(regex)) {
		const linkText = match[1].trim();
		if (!seen.has(linkText)) {
			seen.add(linkText);
			links.push(linkText);
		}
	}
	return links;
}

module.exports = class AtLineAIPlugin extends Plugin {
	async onload() {
		// Load settings
		await this.loadSettings();

		// Inject CSS for loading animations
		this.injectStyles();

		// Create shared reference for agents (used by pill plugin and autocomplete)
		// This allows dynamic updates without reloading
		this.agentsRef = {
			current: this.settings.agents,
			version: 0
		};

		// Add settings tab
		this.addSettingTab(new AtLineAISettingTab(this.app, this));

		// Register CodeMirror 6 extension for agent pill styling
		this.registerEditorExtension(createAgentPillPlugin(this.agentsRef));

		// Register CodeMirror 6 autocomplete for all agents
		this.registerEditorExtension(createAgentAutocomplete(this.agentsRef));

		// Register CodeMirror 6 extension for loading animation
		this.registerEditorExtension(createLoadingAnimationPlugin());

		// Register markdown post-processor for loading animation in reading mode
		this.registerMarkdownPostProcessor((element, context) => {
			// Find callouts that contain loading indicators
			const callouts = element.querySelectorAll('.callout');
			for (const callout of callouts) {
				const content = callout.querySelector('.callout-content');
				if (content && content.textContent.includes('is thinking...')) {
					// Add loading class to the callout
					callout.classList.add('atline-ai-loading-callout');

					// Wrap hourglass emoji in animated span
					const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
					let node;
					while ((node = walker.nextNode())) {
						if (node.textContent.includes('⏳')) {
							const span = document.createElement('span');
							span.className = 'atline-ai-loading-emoji';
							span.textContent = '⏳';
							node.textContent = node.textContent.replace('⏳', '');
							node.parentNode.insertBefore(span, node);
							break;
						}
					}
				}
			}
		});

		// Cache regex pattern for agent matching (performance optimization)
		this.updateAgentPattern();

		// Initialize memoization cache for formatAsBlockquote (optimization #6)
		this.formatCache = { text: '', result: '', style: '' };

		// Add command for triggering agent queries
		// Users can customize the hotkey in Obsidian's Settings > Hotkeys
		this.addCommand({
			id: 'run-atline-ai',
			name: 'Run AI agent on current line',
			editorCallback: async (editor, view) => {
				const cursor = editor.getCursor();

				// Search upward from cursor position (max 20 lines) to find @agent trigger
				const lines = editor.getValue().split('\n');
				const result = this.findAgentTrigger(lines, cursor.line);

				if (!result) {
					new Notice('No agent query found within 20 lines above cursor');
					return;
				}

				let { agentLine, agentMatch } = result;

				// Extract question from @agent trigger to cursor position
				const agentAlias = agentMatch[1];
				let question = '';

				if (agentLine === cursor.line) {
					// Single-line query
					question = agentMatch[2].trim();
				} else {
					// Multi-line query: capture from @agent to cursor
					const firstLine = editor.getLine(agentLine);
					const agentIndex = firstLine.indexOf(`@${agentAlias}`);
					const firstPart = firstLine.substring(agentIndex + agentAlias.length + 1).trim();

					const middleLines = [];
					for (let i = agentLine + 1; i < cursor.line; i++) {
						middleLines.push(editor.getLine(i));
					}

					const lastLine = editor.getLine(cursor.line);
					const lastPart = lastLine.substring(0, cursor.ch);

					question = [firstPart, ...middleLines, lastPart].join('\n').trim();
				}

				await this.runAgentQuery(editor, cursor, view, question, agentAlias);
			}
		});
	}

	/**
	 * Updates the cached regex patterns and agent lookup map when agents change.
	 * Creates regex patterns for matching @agent triggers in notes.
	 * @returns {void}
	 */
	updateAgentPattern() {
		// Cache compiled regex patterns for performance
		const aliases = this.settings.agents.map(a => a.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
		this.agentPattern = new RegExp(`^@(${aliases.join('|')})\\s+(.+)$`);
		this.agentPatternLoose = new RegExp(`@(${aliases.join('|')})\\s+(.+)`);

		// Cache agent lookup Map for O(1) access (optimization #2)
		this.agentMap = new Map(this.settings.agents.map(a => [a.alias, a]));
	}

	findAgentTrigger(lines, cursorLine) {
		const MAX_SEARCH = 20;
		const searchStart = Math.max(0, cursorLine - MAX_SEARCH);
		for (let i = cursorLine; i >= searchStart; i--) {
			const match = lines[i] && lines[i].match(this.agentPatternLoose);
			if (match) return { agentLine: i, agentMatch: match };
		}
		return null;
	}

	/**
	 * Loads plugin settings from disk storage.
	 * @returns {Promise<void>}
	 */
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Migrate: replace old @3b1b and @desmos with unified @plot agent
		if (this.settings.agents) {
			let needsSave = false;
			// Remove old @3b1b agent if it exists
			const idx3b1b = this.settings.agents.findIndex(a => a.alias === '3b1b');
			if (idx3b1b !== -1) {
				this.settings.agents.splice(idx3b1b, 1);
				needsSave = true;
			}
			// Remove old @desmos agent if it exists
			const idxDesmos = this.settings.agents.findIndex(a => a.alias === 'desmos');
			if (idxDesmos !== -1) {
				this.settings.agents.splice(idxDesmos, 1);
				needsSave = true;
			}
			// Add @plot agent if it doesn't exist
			if (!this.settings.agents.find(a => a.alias === 'plot')) {
				const defaultAgent = DEFAULT_SETTINGS.agents.find(a => a.alias === 'plot');
				if (defaultAgent) {
					this.settings.agents.push(defaultAgent);
					needsSave = true;
				}
			}
			if (needsSave) {
				await this.saveData(this.settings);
			}
		}
		// Auto-detect CLI paths if still using defaults
		await this.autoDetectCliPaths();
	}

	/**
	 * Auto-detects CLI paths by running `which` through the user's shell.
	 * Only updates paths that are still set to default values.
	 */
	async autoDetectCliPaths() {
		const pathsToDetect = [
			{ setting: 'nodePath', command: 'node', default: 'node' },
			{ setting: 'claudePath', command: 'claude', default: 'claude' },
			{ setting: 'geminiPath', command: 'gemini', default: 'gemini' },
			{ setting: 'codexPath', command: 'codex', default: 'codex' }
		];

		let updated = false;
		for (const { setting, command, default: defaultVal } of pathsToDetect) {
			// Only auto-detect if using the default (non-absolute) path
			if (this.settings[setting] === defaultVal) {
				const detectedPath = await this.detectCliPath(command);
				if (detectedPath) {
					this.settings[setting] = detectedPath;
					updated = true;
				}
			}
		}

		if (updated) {
			await this.saveData(this.settings);
		}
	}

	/**
	 * Detects the full path of a CLI command by running `which` through the user's shell.
	 * @param {string} command - The command to find (e.g., 'node', 'claude')
	 * @returns {Promise<string|null>} - The full path or null if not found
	 */
	detectCliPath(command) {
		return new Promise((resolve) => {
			// Use the user's default shell to get their PATH (including NVM, etc.)
			const shell = process.env.SHELL || '/bin/bash';
			// Run as interactive login shell to source profile files
			// Using execFile with array args prevents shell injection
			execFile(shell, ['-ilc', `which ${command}`], {
				timeout: 5000,
				env: { ...process.env, HOME: os.homedir() }
			}, (error, stdout) => {
				if (error || !stdout) {
					resolve(null);
					return;
				}
				const detectedPath = stdout.trim();
				// Verify it's an absolute path
				if (detectedPath && detectedPath.startsWith('/')) {
					resolve(detectedPath);
				} else {
					resolve(null);
				}
			});
		});
	}

	/**
	 * Gets the effective system prompt for an agent.
	 * For @plot agent, returns the library-specific prompt based on plotLibrary setting.
	 * @param {Object} agent - The agent configuration
	 * @returns {string} - The system prompt to use
	 */
	getAgentSystemPrompt(agent) {
		// For @plot agent, use the library-specific prompt
		if (agent.alias === 'plot' && agent.plotLibrary && PLOT_LIBRARY_PROMPTS[agent.plotLibrary]) {
			return PLOT_LIBRARY_PROMPTS[agent.plotLibrary];
		}
		// For other agents, use their configured system prompt
		return agent.systemPrompt || '';
	}

	/**
	 * Saves plugin settings to disk storage and updates cached patterns.
	 * @returns {Promise<void>}
	 */
	async saveSettings() {
		await this.saveData(this.settings);
		// Update cached patterns when settings change
		this.updateAgentPattern();
		// Update agents reference to trigger pill plugin refresh
		if (this.agentsRef) {
			this.agentsRef.current = this.settings.agents;
			this.agentsRef.version++;
		}
	}

	/**
	 * Injects CSS styles for loading animations into the document.
	 * Called once on plugin load.
	 */
	injectStyles() {
		// Check if styles already injected (prevent duplicates on reload)
		if (document.getElementById('atline-ai-loading-styles')) {
			return;
		}

		const styleEl = document.createElement('style');
		styleEl.id = 'atline-ai-loading-styles';
		styleEl.textContent = LOADING_ANIMATION_CSS;
		document.head.appendChild(styleEl);
	}

	// Helper: Find and replace text efficiently using replaceRange instead of setValue
	replaceInDocument(editor, searchRegex, replacement) {
		const doc = editor.getValue();
		const match = doc.match(searchRegex);

		if (!match) return false;

		const startPos = editor.offsetToPos(match.index);
		const endPos = editor.offsetToPos(match.index + match[0].length);

		// Use replaceRange for targeted update (much faster than setValue)
		editor.replaceRange(replacement, startPos, endPos);
		return true;
	}

	/**
	 * Formats a loading indicator according to the user's response style preference.
	 * @param {string} providerName - Name of the AI provider (e.g., "Claude", "Gemini")
	 * @param {string} markerId - Unique marker ID for tracking this specific response
	 * @returns {string} Formatted loading text with appropriate styling
	 */
	formatLoadingIndicator(providerName, markerId, responseStyle = null) {
		// Format loading indicator based on user's response style preference
		const style = responseStyle || this.settings.responseStyle || 'blockquote';
		const loadingMsg = `⏳ *${providerName} is thinking...*`;

		switch (style) {
			case 'blockquote':
				return `\n\n> ${loadingMsg} <!-- ${markerId} -->\n`;

			case 'callout':
				return `\n\n> [!info]+ ${providerName}\n> ${loadingMsg} <!-- ${markerId} -->\n`;

			case 'plain':
				return `\n\n---\n\n${loadingMsg} <!-- ${markerId} -->\n\n---\n`;

			case 'code':
				return `\n\n\`\`\`\n${loadingMsg} <!-- ${markerId} -->\n\`\`\`\n`;

			default:
				return `\n\n> ${loadingMsg} <!-- ${markerId} -->\n`;
		}
	}


	/**
	 * Executes an AI agent query and displays the response inline in the note.
	 * Handles the full lifecycle: validation, loading animation, API call, and response formatting.
	 * @param {Editor} editor - Obsidian editor instance
	 * @param {Object} cursor - Cursor position object with line and ch properties
	 * @param {MarkdownView} view - Obsidian markdown view containing the editor
	 * @param {string} question - The user's question to send to the AI
	 * @param {string} agentAlias - Alias of the agent to use (e.g., 'claude', 'gemini')
	 * @returns {Promise<void>}
	 */
	async runAgentQuery(editor, cursor, view, question, agentAlias = 'claude') {
		// Find the agent configuration (optimization #2: O(1) Map lookup)
		const agent = this.agentMap.get(agentAlias);
		if (!agent) {
			new Notice(`Agent @${agentAlias} not found in settings`);
			return;
		}

		// Determine provider and set appropriate strings
		const provider = agent.provider;
		const providerName = provider === 'gemini' ? 'Gemini' : (provider === 'ollama' ? 'Ollama' : provider === 'codex' ? 'OpenAI' : 'Claude');

		// Determine if using API mode (for Claude, OpenAI, or Gemini)
		const useClaudeApi = provider === 'claude' && agent.connectionMode === 'api' && this.settings.claudeApiKey;
		const useOpenaiApi = provider === 'codex' && agent.connectionMode === 'api' && this.settings.openaiApiKey;
		const useGeminiApi = provider === 'gemini' && agent.connectionMode === 'api' && this.settings.geminiApiKey;

		// Append contextual instruction to system prompt (different for each provider/mode)
		let markerInstruction = '';
		if (provider === 'ollama' || useClaudeApi || useOpenaiApi || useGeminiApi) {
			// Ollama, Claude API, OpenAI API, and Gemini API get file contents directly
			markerInstruction = '\n\nIMPORTANT: The user\'s question appears at a specific location in the file, marked with \'<<< USER IS ASKING THEIR QUESTION FROM THIS LINE >>>\'. When they use words like \'this\', \'here\', \'explain this better\', \'what does this mean\', etc., they are referring to the content immediately above this marker. Look for this marker to understand the exact context of what section they\'re asking about.\n\nCRITICAL: ALL file contents (including any referenced files) are ALREADY PROVIDED in the message. DO NOT say you will "read" or "check" files - they are already available. Just answer the question directly using the provided content.';
		} else {
			// Claude CLI, Gemini CLI, and Codex CLI will read files themselves
			markerInstruction = '\n\nIMPORTANT: The user is asking a question about their Obsidian note. You will be given the file path and line number. Read the file(s) to understand the context, then answer their question. When they use words like \'this\', \'here\', \'explain this better\', etc., they are referring to content near the line number they specified.';
		}
		let systemPrompt = (this.getAgentSystemPrompt(agent) || '') + markerInstruction;

		// Use agent-specific settings with fallback to global settings
		const responseStyle = agent.responseStyle || this.settings.responseStyle;
		const timeout = agent.timeout || this.settings.timeout;
		const model = agent.model;

		// Generate unique marker for this query
		const markerId = `agent-${crypto.randomUUID()}`;

		// Format loading text according to response style (agent-specific or global)
		const loadingText = this.formatLoadingIndicator(providerName, markerId, responseStyle);

		// For single-line queries, normalize the trigger line formatting.
		// For multiline queries, leave all existing lines untouched — reformatting
		// would re-insert the full question at the cursor line, duplicating content.
		if (question.includes('\n')) {
			// Multiline: just append loading indicator after the cursor line as-is
			const cursorLineLength = editor.getLine(cursor.line).length;
			editor.replaceRange(loadingText, { line: cursor.line, ch: cursorLineLength });
		} else {
			// Single-line: normalize to `@alias question` then append loading indicator
			const line = editor.getLine(cursor.line);
			const formattedLine = `@${agentAlias} ${question}`;
			editor.replaceRange(formattedLine, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
			editor.replaceRange(loadingText, { line: cursor.line, ch: formattedLine.length });
		}

		new Notice(`Running ${providerName} (${agentAlias})...`);

		const filePath = view.file.path;
		const vaultPath = this.app.vault.adapter.basePath;
		const absolutePath = path.join(vaultPath, filePath);

		// Track query line for potential deletion
		const queryLine = cursor.line;

		try {
			const disableStreaming = agent.disableStreaming || false;

			// Route to direct API if configured (Claude, OpenAI, or Gemini)
			if (useClaudeApi || useOpenaiApi || useGeminiApi) {
				// Read file contents for API mode (API can't read files like CLI)
				const { readFile } = require('fs').promises;
				const fileName = path.basename(absolutePath);

				let currentFileContents = '';
				try {
					currentFileContents = await readFile(absolutePath, 'utf-8');
				} catch (error) {
					throw new Error(`Could not read file: ${absolutePath}. Error: ${error.message}`);
				}

				// Insert marker at the line where the query appears
				const fileLines = currentFileContents.split('\n');
				if (cursor.line >= 0 && cursor.line < fileLines.length) {
					fileLines.splice(cursor.line + 1, 0, '<<< USER IS ASKING THEIR QUESTION FROM THIS LINE >>>');
				}
				currentFileContents = fileLines.join('\n');

				// Extract and read wikilinked files
				const wikilinks = [];
				const linkPromises = [];
				const sourceText = agent.includeAllWikilinks ? currentFileContents : question;

				for (const linkText of extractWikilinks(sourceText)) {
					const linkedFile = this.app.metadataCache.getFirstLinkpathDest(linkText, filePath);
					if (linkedFile) {
						const linkedPath = path.join(vaultPath, linkedFile.path);
						linkPromises.push(
							readFile(linkedPath, 'utf-8')
								.then(linkedContents => ({ name: linkText, contents: linkedContents }))
								.catch(() => null)
						);
					}
				}

				const results = await Promise.all(linkPromises);
				wikilinks.push(...results.filter(r => r !== null));

				if (wikilinks.length > 0) {
					new Notice(`Including context from: ${wikilinks.map(w => `[[${w.name}]]`).join(', ')}`, 3000);
				}

				// Build context info
				let referencedFilesInfo = '';
				if (wikilinks.length > 0) {
					referencedFilesInfo = '\n\n---\n\nREFERENCED FILES:\n\n';
					for (const link of wikilinks) {
						referencedFilesInfo += `### [[${link.name}]]\n\n${link.contents}\n\n---\n\n`;
					}
				}

				const contextInfo = `CURRENT FILE: ${fileName}\n\n${currentFileContents}${referencedFilesInfo}`;

				// Call the appropriate API
				if (useClaudeApi) {
					await this.runClaudeApiStreaming(editor, markerId, contextInfo, question, systemPrompt, timeout, responseStyle, model);
				} else if (useOpenaiApi) {
					await this.runOpenAIApiStreaming(editor, markerId, contextInfo, question, systemPrompt, timeout, responseStyle, model);
				} else {
					await this.runGeminiApiStreaming(editor, markerId, contextInfo, question, systemPrompt, timeout, responseStyle, model);
				}
			} else {
				// Use CLI streaming (existing path)
				await this.runCLIStreaming(editor, markerId, absolutePath, question, null, cursor.line, provider, systemPrompt, agent.includeAllWikilinks || false, timeout, responseStyle, model, disableStreaming);
			}
			new Notice(`${providerName} responded!`);

			// Delete the query line if option is enabled
			if (agent.deleteQueryAfterResponse) {
				// Delete the entire query line (from start of line to start of next line)
				editor.replaceRange('', { line: queryLine, ch: 0 }, { line: queryLine + 1, ch: 0 });
			}

		} catch (error) {
			// Better error formatting
			let errorMsg = 'Unknown error occurred';
			if (error.stderr && error.stderr.trim()) {
				errorMsg = error.stderr.trim();
			} else if (error.stdout && error.stdout.trim()) {
				errorMsg = error.stdout.trim();
			} else if (error.message) {
				errorMsg = error.message;
			}

			const response = `\n\n> ❌ **Error:** ${errorMsg}\n\n> _Provider: ${providerName}_\n`;
			this.replaceLoadingMarker(editor, markerId, response);
			new Notice(`${providerName} encountered an error - check note for details`);
			console.error(`${providerName} error details:`, {
				error: error.message,
				stderr: error.stderr,
				stdout: error.stdout,
				code: error.code
			});
		}
	}

	/**
	 * Builds CLI configuration for Claude provider.
	 * @param {string} contextPrompt - Context including file paths and question
	 * @param {string} systemPrompt - System prompt for the AI
	 * @param {string} sessionId - Session ID for conversation continuity
	 * @param {string} vaultPath - Absolute path to the vault
	 * @param {string} model - Optional model name (e.g., 'claude-opus-4')
	 * @returns {Object} Configuration object with nodePath, cliPath, cliArgs, and cwd
	 */
	buildClaudeConfig(contextPrompt, systemPrompt, sessionId, vaultPath, model = null) {
		const cliArgs = [
			'-p',
			'--output-format', 'stream-json',
			'--verbose',
			`--add-dir=${vaultPath}`
		];

		if (model) {
			cliArgs.push('--model', model);
		}

		// Only add system prompt if it's not empty
		if (systemPrompt && systemPrompt.trim() !== '') {
			cliArgs.push('--system-prompt', systemPrompt);
		}

		if (sessionId && sessionId !== 'null') {
			cliArgs.push('--session-id', sessionId);
		}

		cliArgs.push(contextPrompt);

		return {
			nodePath: this.settings.nodePath,
			cliPath: this.settings.claudePath,
			cliArgs,
			cwd: os.tmpdir(),
			directExec: this.settings.claudeDirectExec
		};
	}

	/**
	 * Builds CLI configuration for Gemini provider.
	 * @param {string} contextPrompt - Context including file paths and question
	 * @param {string} systemPrompt - System prompt for the AI
	 * @param {string} sessionId - Session ID for conversation continuity
	 * @param {string} vaultPath - Absolute path to the vault
	 * @param {string} model - Optional model name (e.g., 'gemini-2.0-flash-exp')
	 * @returns {Object} Configuration object with nodePath, cliPath, cliArgs, and cwd
	 */
	buildGeminiConfig(contextPrompt, systemPrompt, sessionId, vaultPath, model = null) {
		const geminiPrompt = systemPrompt
			? `${systemPrompt}\n\n${contextPrompt}`
			: contextPrompt;

		const cliArgs = ['-o', 'stream-json'];

		if (model) {
			cliArgs.push('-m', model);
		}

		if (sessionId && sessionId !== 'null') {
			cliArgs.push('-r', sessionId);
		}

		cliArgs.push(geminiPrompt);

		return {
			nodePath: this.settings.nodePath,
			cliPath: this.settings.geminiPath,
			cliArgs,
			cwd: vaultPath
		};
	}

	/**
	 * Builds CLI configuration for Codex provider.
	 * @param {string} contextPrompt - Context including file paths and question
	 * @param {string} systemPrompt - System prompt for the AI
	 * @param {string} vaultPath - Absolute path to the vault
	 * @param {string} model - Optional model name (e.g., 'gpt-4o', 'o1')
	 * @returns {Object} Configuration object with nodePath, cliPath, cliArgs, and cwd
	 */
	buildCodexConfig(contextPrompt, systemPrompt, vaultPath, model = null) {
		const codexPrompt = systemPrompt
			? `${systemPrompt}\n\n${contextPrompt}`
			: contextPrompt;

		const cliArgs = [
			'exec',
			'--json',
			'--skip-git-repo-check',
			`--add-dir=${vaultPath}`,
			'-C', vaultPath
		];

		// Use agent-specific model if provided
		if (model) {
			cliArgs.push('-m', model);
		}

		cliArgs.push(codexPrompt);

		return {
			nodePath: this.settings.nodePath,
			cliPath: this.settings.codexPath,
			cliArgs,
			cwd: vaultPath
		};
	}

	/**
	 * Tests the connection to an AI provider to verify correct configuration.
	 * @param {string} provider - AI provider: 'claude', 'gemini', 'ollama', or 'codex'
	 * @param {Object} agent - Agent configuration object
	 * @returns {Promise<void>}
	 */
	async testConnection(provider, agent) {
		const providerName = provider === 'gemini' ? 'Gemini' : (provider === 'ollama' ? 'Ollama' : provider === 'codex' ? 'OpenAI' : 'Claude');
		new Notice(`Testing ${providerName} connection...`);

		try {
			if (provider === 'ollama') {
				// Test Ollama HTTP endpoint
				const response = await fetch(`${this.settings.ollamaBaseUrl}/api/generate`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						model: agent.model || 'llama2',
						prompt: 'What is 2+2?',
						stream: false
					})
				});

				if (!response.ok) {
					throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				}

				const data = await response.json();
				if (data.response) {
					new Notice(`✓ ${providerName} connected successfully!`, 3000);
				} else {
					throw new Error('No response from Ollama');
				}
			} else {
				// Test CLI-based providers (Claude, Gemini, Codex)
				const vaultPath = this.app.vault.adapter.basePath;
				let config;

				if (provider === 'claude') {
					config = this.buildClaudeConfig('What is 2+2?', '', null, vaultPath);
				} else if (provider === 'gemini') {
					config = this.buildGeminiConfig('What is 2+2?', '', vaultPath);
				} else if (provider === 'codex') {
					config = this.buildCodexConfig('What is 2+2?', '', vaultPath);
				}

				// Run test with 30 second timeout (Claude can be slow to initialize)
				const testCmd = config.directExec ? config.cliPath : config.nodePath;
				const testArgs = config.directExec ? config.cliArgs : [config.cliPath, ...config.cliArgs];
				const childProcess = execFile(
					testCmd,
					testArgs,
					{
						cwd: config.cwd,
						maxBuffer: 1024 * 1024, // 1MB for test
						timeout: 30000, // 30 second timeout
						env: { ...process.env, HOME: process.env.HOME }
					}
				);

				// Close stdin immediately to prevent CLI from waiting for input
				if (childProcess.stdin) {
					childProcess.stdin.end();
				}

				let output = '';
				let errorOutput = '';
				let hasResponse = false;

				childProcess.stdout.on('data', (data) => {
					output += data.toString();
					// Check for various response indicators depending on provider
					if (provider === 'claude' && (output.includes('"type":"text"') || output.includes('"text":'))) {
						hasResponse = true;
					} else if (provider === 'gemini' && output.includes('"text"')) {
						hasResponse = true;
					} else if (provider === 'codex' && (output.includes('item.completed') || output.includes('"text"'))) {
						hasResponse = true;
					}
				});

				childProcess.stderr.on('data', (data) => {
					errorOutput += data.toString();
				});

				await new Promise((resolve, reject) => {
					childProcess.on('close', (code) => {
						if (code === 0 && hasResponse) {
							resolve();
						} else if (code === 0 && !hasResponse) {
							reject(new Error(`CLI ran but no response detected. Output: ${output.substring(0, 200)}`));
						} else if (code === 143) {
							reject(new Error(`Timeout after 30s. Check internet connection and ${providerName} CLI status.`));
						} else {
							const errorMsg = errorOutput || output || `CLI exited with code ${code}`;
							reject(new Error(errorMsg.substring(0, 500)));
						}
					});

					childProcess.on('error', (error) => {
						reject(error);
					});
				});

				new Notice(`✓ ${providerName} connected successfully!`, 3000);
			}
		} catch (error) {
			let errorMsg = error.message || 'Unknown error';

			// Provide helpful error messages
			if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
				errorMsg = `${providerName} CLI not found. Please check the path in settings.`;
			} else if (errorMsg.includes('ECONNREFUSED')) {
				errorMsg = `Cannot connect to ${providerName}. Is the service running?`;
			} else if (errorMsg.includes('timeout')) {
				errorMsg = `${providerName} connection timeout. Check your internet/service.`;
			}

			new Notice(`✗ ${providerName} test failed: ${errorMsg}`, 5000);
			console.error(`Test connection error for ${provider}:`, error);
		}
	}

	/**
	 * Runs Codex CLI with file contents passed directly in the prompt.
	 * This bypasses Codex's sandbox restrictions by not requiring it to read files.
	 */
	async runCodexCLIWithContents(editor, markerId, nodePath, cliPath, cliArgs, cwd, timeout, responseStyle, disableStreaming) {
		return new Promise((resolve, reject) => {
			let accumulatedText = '';
			let buffer = '';
			let killTimer;
			let stderrData = '';

			setImmediate(() => {
				const child = spawn(nodePath, [cliPath, ...cliArgs], {
					cwd: cwd,
					env: { ...process.env, HOME: process.env.HOME },
					stdio: ['pipe', 'pipe', 'pipe']
				});

				// Handle process completion
				child.on('close', (code) => {
					clearTimeout(killTimer);

					// Update with complete response when done
					if (accumulatedText) {
						const response = this.formatAsBlockquote(accumulatedText, responseStyle);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
					}

					if (code !== 0 && !accumulatedText) {
						reject(new Error(`Codex CLI exited with code ${code}${stderrData ? ': ' + stderrData.trim() : ''}`));
					} else {
						resolve(accumulatedText);
					}
				});

				child.on('error', (error) => {
					clearTimeout(killTimer);
					reject(error);
				});

				// Set a timeout
				killTimer = setTimeout(() => {
					if (!accumulatedText) {
						child.kill();
						reject(new Error(`Codex request timed out after ${timeout}ms.`));
					}
				}, timeout);

				// Close stdin immediately
				if (child.stdin) {
					child.stdin.end();
				}

				// Process stdout
				if (child.stdout) {
					child.stdout.on('data', (chunk) => {
						buffer += chunk.toString();
						const lines = buffer.split('\n');
						buffer = lines.pop();

						for (const line of lines) {
							if (!line.trim()) continue;

							try {
								const data = JSON.parse(line);

								// Codex format: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
								if (data.type === 'item.completed' && data.item?.text) {
									if (data.item.type === 'agent_message' || data.item.type === 'message') {
										accumulatedText += data.item.text;
									}
								} else if (data.type === 'message.delta' && data.content) {
									accumulatedText += data.content;
								}
							} catch (e) {
								// Ignore parse errors
							}
						}
					});
				}

				// Handle stderr
				if (child.stderr) {
					child.stderr.on('data', (chunk) => {
						stderrData += chunk.toString();
					});
				}
			});
		});
	}

	/**
	 * Runs a streaming AI CLI command and updates the editor in real-time with the response.
	 * Supports Claude, Gemini, and Codex providers with streaming JSON output.
	 * @param {Editor} editor - Obsidian editor instance
	 * @param {string} markerId - Unique marker ID for tracking this response
	 * @param {string} filePath - Absolute path to the current file
	 * @param {string} question - The user's question to send to the AI
	 * @param {string} sessionId - Unique session identifier for conversation continuity
	 * @param {number} lineNumber - Line number where the query was made
	 * @param {string} provider - AI provider: 'claude', 'gemini', or 'codex'
	 * @param {string} systemPrompt - Custom system prompt for the AI
	 * @param {boolean} includeAllWikilinks - Whether to extract wikilinks from entire file or just the question
	 * @param {number} timeout - Timeout in milliseconds for the AI request
	 * @param {string} responseStyle - Response style: 'blockquote', 'callout', 'plain', or 'code'
	 * @param {string} model - Optional model name to use for the AI provider
	 * @param {boolean} disableStreaming - If true, only show final result (no live updates)
	 * @returns {Promise<string>} The accumulated response text from the AI
	 */
	async runCLIStreaming(editor, markerId, filePath, question, sessionId, lineNumber, provider = 'claude', systemPrompt = '', includeAllWikilinks = false, timeout = 120000, responseStyle = 'blockquote', model = null, disableStreaming = false) {
		const fileName = path.basename(filePath);
		const { readFile } = require('fs').promises;

		// Handle Ollama provider separately (uses HTTP API, needs file contents)
		if (provider === 'ollama') {
			// Read the current file contents for Ollama
			let currentFileContents = '';
			try {
				currentFileContents = await readFile(filePath, 'utf-8');
			} catch (error) {
				console.error('Error reading file:', error);
				throw new Error(`Could not read file: ${filePath}. Check that the file exists and you have read permissions. Error: ${error.message}`);
			}

			// Insert marker at the line where the query appears
			const fileLines = currentFileContents.split('\n');
			if (lineNumber >= 0 && lineNumber < fileLines.length) {
				fileLines.splice(lineNumber + 1, 0, '<<< USER IS ASKING THEIR QUESTION FROM THIS LINE >>>');
			}
			currentFileContents = fileLines.join('\n');

			// Extract wikilinks and read their contents in parallel
			const linkPromises = [];
			const wikilinks = [];

			// Determine source text for wikilink extraction
			const sourceText = includeAllWikilinks ? currentFileContents : question;

			// Collect all wikilinks (with deduplication)
			for (const linkText of extractWikilinks(sourceText)) {
				const linkedFile = this.app.metadataCache.getFirstLinkpathDest(linkText, filePath);
				if (linkedFile) {
					const linkedPath = path.join(this.app.vault.adapter.basePath, linkedFile.path);
					linkPromises.push(
						readFile(linkedPath, 'utf-8')
							.then(linkedContents => ({ name: linkText, path: linkedPath, contents: linkedContents }))
							.catch(error => {
								console.error(`Error reading wikilinked file ${linkText}:`, error);
								return null;
							})
					);
				}
			}

			// Read all wikilinked files in parallel
			const results = await Promise.all(linkPromises);
			wikilinks.push(...results.filter(r => r !== null));

			// Show wikilink context preview
			if (wikilinks.length > 0) {
				const wikilinkNames = wikilinks.map(w => `[[${w.name}]]`).join(', ');
				new Notice(`Including context from: ${wikilinkNames}`, 3000);
			}

			// Build referenced files section with contents
			let referencedFilesInfo = '';
			if (wikilinks.length > 0) {
				referencedFilesInfo = '\n\n---\n\nREFERENCED FILES:\n\n';
				for (const link of wikilinks) {
					referencedFilesInfo += `### [[${link.name}]]\n\n${link.contents}\n\n---\n\n`;
				}
			}

			const contextInfo = `CURRENT FILE: ${fileName}\n\n${currentFileContents}${referencedFilesInfo}`;
			return this.runOllamaStreaming(editor, markerId, contextInfo, question, systemPrompt, timeout, responseStyle, model);
		}

		// For Codex CLI: read file contents and pass directly (Codex has sandbox restrictions)
		if (provider === 'codex') {
			// Read the current file contents for Codex
			let currentFileContents = '';
			try {
				currentFileContents = await readFile(filePath, 'utf-8');
			} catch (error) {
				console.error('Error reading file:', error);
				throw new Error(`Could not read file: ${filePath}. Error: ${error.message}`);
			}

			// Insert marker at the line where the query appears
			const fileLines = currentFileContents.split('\n');
			if (lineNumber >= 0 && lineNumber < fileLines.length) {
				fileLines.splice(lineNumber + 1, 0, '<<< USER IS ASKING THEIR QUESTION FROM THIS LINE >>>');
			}
			currentFileContents = fileLines.join('\n');

			// Extract wikilinks and read their contents in parallel
			const wikilinks = [];
			const linkPromises = [];

			// Determine source text for wikilink extraction
			const sourceText = includeAllWikilinks ? currentFileContents : question;

			// Collect all wikilinks (with deduplication)
			for (const linkText of extractWikilinks(sourceText)) {
				const linkedFile = this.app.metadataCache.getFirstLinkpathDest(linkText, filePath);
				if (linkedFile) {
					const linkedPath = path.join(this.app.vault.adapter.basePath, linkedFile.path);
					linkPromises.push(
						readFile(linkedPath, 'utf-8')
							.then(linkedContents => ({ name: linkText, contents: linkedContents }))
							.catch(() => null)
					);
				}
			}

			// Read all wikilinked files in parallel
			const linkedResults = await Promise.all(linkPromises);
			const validLinks = linkedResults.filter(Boolean);

			// Show wikilink context preview
			if (validLinks.length > 0) {
				new Notice(`Including context from: ${validLinks.map(w => `[[${w.name}]]`).join(', ')}`, 3000);
			}

			// Build context info with file contents
			let referencedFilesInfo = '';
			if (validLinks.length > 0) {
				referencedFilesInfo = '\n\n--- REFERENCED FILES ---\n';
				for (const link of validLinks) {
					referencedFilesInfo += `\n[[${link.name}]]:\n${link.contents}\n`;
				}
			}

			const contextInfo = `CURRENT FILE: ${fileName}\n\n${currentFileContents}${referencedFilesInfo}`;
			const codexPrompt = systemPrompt
				? `${systemPrompt}\n\n${contextInfo}\n\nQuestion: ${question}`
				: `${contextInfo}\n\nQuestion: ${question}`;

			const vaultPath = this.app.vault.adapter.basePath;
			const config = this.buildCodexConfig(codexPrompt, '', vaultPath, model);
			const { nodePath, cliPath, cliArgs, cwd } = config;

			return this.runCodexCLIWithContents(editor, markerId, nodePath, cliPath, cliArgs, cwd, timeout, responseStyle, disableStreaming);
		}

		// For Claude and Gemini: pass file paths, let CLIs read files themselves
		// Extract wikilink file paths (not contents)
		const wikilinkedPaths = [];

		// Determine source text for wikilink extraction
		let sourceText = question;
		if (includeAllWikilinks) {
			// Scan entire file for wikilinks
			try {
				sourceText = await readFile(filePath, 'utf-8');
			} catch (error) {
				sourceText = question; // Fallback to question only
			}
		}

		// Collect all wikilinks (with deduplication)
		for (const linkText of extractWikilinks(sourceText)) {
			const linkedFile = this.app.metadataCache.getFirstLinkpathDest(linkText, filePath);
			if (linkedFile) {
				const linkedPath = path.join(this.app.vault.adapter.basePath, linkedFile.path);
				wikilinkedPaths.push({ name: linkText, path: linkedPath });
			}
		}

		// Show wikilink context preview
		if (wikilinkedPaths.length > 0) {
			const wikilinkNames = wikilinkedPaths.map(w => `[[${w.name}]]`).join(', ');
			new Notice(`Including context from: ${wikilinkNames}`, 3000);
		}

		// Build context with file paths (not contents)
		let contextPrompt = `The user is working in the file: ${filePath}\n`;
		if (lineNumber >= 0) {
			contextPrompt += `They are asking their question from line ${lineNumber + 1}.\n`;
		}
		if (wikilinkedPaths.length > 0) {
			contextPrompt += `\nThey also referenced these files:\n`;
			for (const link of wikilinkedPaths) {
				contextPrompt += `- [[${link.name}]]: ${link.path}\n`;
			}
		}
		contextPrompt += `\nQuestion: ${question}`;

		// Build CLI configuration using helper methods
		const vaultPath = this.app.vault.adapter.basePath;
		let config;

		if (provider === 'gemini') {
			config = this.buildGeminiConfig(contextPrompt, systemPrompt, sessionId, vaultPath, model);
		} else {
			config = this.buildClaudeConfig(contextPrompt, systemPrompt, sessionId, vaultPath, model);
		}

		const { nodePath, cliPath, cliArgs, cwd, directExec } = config;
		const spawnCmd = directExec ? cliPath : nodePath;
		const spawnArgs = directExec ? cliArgs : [cliPath, ...cliArgs];

		return new Promise((resolve, reject) => {
			let accumulatedText = '';
			let buffer = '';
			let killTimer;

			// Use setImmediate to ensure spawn happens on next event loop tick
			setImmediate(() => {
				const child = spawn(spawnCmd, spawnArgs, {
					cwd: cwd,
					env: { ...process.env, HOME: process.env.HOME },
					stdio: ['pipe', 'pipe', 'pipe']
				});

			// Handle process completion
			child.on('close', (code) => {
				clearTimeout(killTimer);

				// Clean up timing markers (e.g., "2s", "4s") that can appear in streaming output
				if (accumulatedText && disableStreaming) {
					accumulatedText = accumulatedText.replace(/^\d+s\n/gm, '').replace(/\n\d+s\n/g, '\n');
				}

				// Update with complete response when done
				if (accumulatedText) {
					const response = this.formatAsBlockquote(accumulatedText, responseStyle);
					this.updateStreamingMarker(editor, markerId, response, responseStyle);
				}

				if (code !== 0 && !accumulatedText) {
					reject(new Error(`CLI exited with code ${code}${stderrData ? ': ' + stderrData.trim() : ''}`));
				} else {
					resolve(accumulatedText);
				}
			});

			child.on('error', (error) => {
				clearTimeout(killTimer);
				reject(error);
			});

			// Set a timeout to reject if no data received
			killTimer = setTimeout(() => {
				if (!accumulatedText) {
					child.kill();
					const timeoutMsg = `${provider} request timed out after ${timeout}ms. Try: (1) Increase timeout in Settings → AtLine AI, (2) Check internet connection, (3) Verify ${provider} CLI is working independently, or (4) Check CLI paths in settings.`;
					reject(new Error(timeoutMsg));
				}
			}, timeout);

			// Close stdin immediately to prevent blocking
			if (child.stdin) {
				child.stdin.end();
			}

			// Process stdout data in chunks (accumulate only, don't update editor)
			if (child.stdout) {
				child.stdout.on('data', (chunk) => {
					buffer += chunk.toString();

					// Process complete JSON lines
					const lines = buffer.split('\n');
					buffer = lines.pop(); // Keep incomplete line in buffer

					for (const line of lines) {
						if (!line.trim()) continue;

						try {
							const data = JSON.parse(line);

							// Handle different streaming formats based on provider
							if (provider === 'gemini') {
								// Gemini streaming format - accumulate delta chunks
								if (data.type === 'message' && data.role === 'assistant' && data.content) {
									// Gemini sends content chunks with delta: true
									// Append each chunk to build the complete response
									accumulatedText += data.content;
								}
							} else if (provider === 'codex') {
								// Codex streaming format (event-based)
								// Format: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
								if (data.type === 'item.completed' && data.item?.text) {
									// Append text from completed items (agent messages)
									if (data.item.type === 'agent_message' || data.item.type === 'message') {
										accumulatedText += data.item.text;
									}
								} else if (data.type === 'message.delta' && data.content) {
									// Fallback for streaming delta format
									accumulatedText += data.content;
								}
							} else {
								// Claude streaming format
								if (data.type === 'content_block_delta' && data.delta?.text) {
									accumulatedText += data.delta.text;
								} else if (data.type === 'message_delta' && data.delta?.text) {
									accumulatedText += data.delta.text;
								} else if (data.type === 'assistant' && data.message?.content) {
									// Extract text from all text-type content items (skip tool_use items)
									for (const item of data.message.content) {
										if (item.type === 'text' && item.text) {
											accumulatedText = item.text;
										}
									}
								} else if (data.type === 'result' && data.result) {
									if (!accumulatedText) {
										accumulatedText = data.result;
									}
								}
							}
						} catch (e) {
							console.debug('JSON parse error (incomplete chunk):', e.message);
						}
					}
				});
			}

			// Handle stderr for errors
			let stderrData = '';
			if (child.stderr) {
				child.stderr.on('data', (chunk) => {
					stderrData += chunk.toString();
				});
			}
			}); // close setImmediate
		}); // close Promise
	}

	async runOllamaStreaming(editor, markerId, contextInfo, question, systemPrompt = '', timeout = 120000, responseStyle = 'blockquote', model = null) {
		return new Promise((resolve, reject) => {
			const http = require('http');
			const url = new URL(`${this.settings.ollamaBaseUrl}/api/generate`);

			// Build the full prompt with context and system instructions
			let fullPrompt = '';
			if (systemPrompt) {
				fullPrompt = `${systemPrompt}\n\n${contextInfo}\n\nQuestion: ${question}`;
			} else {
				fullPrompt = `${contextInfo}\n\nQuestion: ${question}`;
			}

			const requestData = JSON.stringify({
				model: model || 'llama2',
				prompt: fullPrompt,
				stream: true
			});

			const options = {
				hostname: url.hostname,
				port: url.port || 11434,
				path: '/api/generate',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(requestData)
				}
			};

			let accumulatedText = '';
			let buffer = '';
			let lastFormattedText = '';
			let batchUpdateInterval = null;
			let killTimer;

			const req = http.request(options, (res) => {
				// Batch editor updates every 100ms (same optimization as CLI streaming)
				batchUpdateInterval = setInterval(() => {
					if (accumulatedText && accumulatedText !== lastFormattedText) {
						// Pass markerId to keep it in the response for subsequent updates
						const response = this.formatAsBlockquote(accumulatedText, responseStyle, markerId);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
						lastFormattedText = accumulatedText;
					}
				}, 100);

				res.on('data', (chunk) => {
					buffer += chunk.toString();

					// Process complete JSON lines
					const lines = buffer.split('\n');
					buffer = lines.pop(); // Keep incomplete line in buffer

					for (const line of lines) {
						if (!line.trim()) continue;

						try {
							const data = JSON.parse(line);

							// Ollama streaming format: { "response": "chunk", "done": false }
							if (data.response) {
								accumulatedText += data.response;
							}

							// Check if streaming is complete
							if (data.done) {
								clearTimeout(timeout);
								if (batchUpdateInterval) clearInterval(batchUpdateInterval);

								// Final update - always strip the marker comment
								if (accumulatedText) {
									const response = this.formatAsBlockquote(accumulatedText, responseStyle);
									this.updateStreamingMarker(editor, markerId, response, responseStyle);
								}

								resolve();
							}
						} catch (e) {
							console.debug('Ollama JSON parse error:', e.message);
						}
					}
				});

				res.on('end', () => {
					clearTimeout(timeout);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);

					// Final update - always strip the marker comment
					if (accumulatedText) {
						const response = this.formatAsBlockquote(accumulatedText, responseStyle);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
					}

					resolve();
				});

				res.on('error', (error) => {
					clearTimeout(killTimer);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);
					reject(error);
				});
			});

			req.on('error', (error) => {
				clearTimeout(killTimer);
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				reject(new Error(`Ollama connection error: ${error.message}. Make sure Ollama is running at ${this.settings.ollamaBaseUrl}`));
			});

			// Set timeout
			killTimer = setTimeout(() => {
				req.destroy();
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				const timeoutMsg = `Ollama request timed out after ${timeout}ms. Try: (1) Increase timeout in Settings → AtLine AI, (2) Check if Ollama is running (curl ${this.settings.ollamaBaseUrl}/api/tags), (3) Verify model "${model || 'llama2'}" is installed, or (4) Check system resources.`;
				reject(new Error(timeoutMsg));
			}, timeout);

			// Send the request
			req.write(requestData);
			req.end();
		});
	}

	/**
	 * Runs a streaming Claude API request and updates the editor in real-time.
	 * Uses direct Anthropic API instead of CLI.
	 * @param {Editor} editor - Obsidian editor instance
	 * @param {string} markerId - Unique marker ID for tracking this response
	 * @param {string} contextInfo - File contents and context
	 * @param {string} question - The user's question
	 * @param {string} systemPrompt - System prompt for Claude
	 * @param {number} timeout - Timeout in milliseconds
	 * @param {string} responseStyle - Response formatting style
	 * @param {string} model - Claude model to use
	 * @returns {Promise<string>} The accumulated response text
	 */
	async runClaudeApiStreaming(editor, markerId, contextInfo, question, systemPrompt = '', timeout = 120000, responseStyle = 'blockquote', model = null) {
		return new Promise((resolve, reject) => {
			const https = require('https');

			// Build the message content
			const userMessage = systemPrompt
				? `${contextInfo}\n\nQuestion: ${question}`
				: `${contextInfo}\n\nQuestion: ${question}`;

			const requestData = JSON.stringify({
				model: model || 'claude-sonnet-4-20250514',
				max_tokens: 4096,
				system: systemPrompt || undefined,
				messages: [{ role: 'user', content: userMessage }],
				stream: true
			});

			const options = {
				hostname: 'api.anthropic.com',
				path: '/v1/messages',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': this.settings.claudeApiKey,
					'anthropic-version': '2023-06-01',
					'Content-Length': Buffer.byteLength(requestData)
				}
			};

			let accumulatedText = '';
			let buffer = '';
			let lastFormattedText = '';
			let batchUpdateInterval = null;
			let killTimer;

			const req = https.request(options, (res) => {
				// Check for error status codes
				if (res.statusCode !== 200) {
					let errorBody = '';
					res.on('data', chunk => errorBody += chunk.toString());
					res.on('end', () => {
						clearTimeout(killTimer);
						let errorMsg = `Claude API error (${res.statusCode})`;
						try {
							const errorJson = JSON.parse(errorBody);
							errorMsg = errorJson.error?.message || errorMsg;
						} catch (e) {
							errorMsg = errorBody || errorMsg;
						}
						reject(new Error(errorMsg));
					});
					return;
				}

				// Batch editor updates every 100ms for performance
				batchUpdateInterval = setInterval(() => {
					if (accumulatedText && accumulatedText !== lastFormattedText) {
						// Pass markerId to keep it in the response for subsequent updates
						const response = this.formatAsBlockquote(accumulatedText, responseStyle, markerId);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
						lastFormattedText = accumulatedText;
					}
				}, 100);

				res.on('data', (chunk) => {
					buffer += chunk.toString();

					// Parse SSE format: "event: type\ndata: json\n\n"
					const events = buffer.split('\n\n');
					buffer = events.pop(); // Keep incomplete event in buffer

					for (const event of events) {
						if (!event.trim()) continue;

						const lines = event.split('\n');
						let eventType = '';
						let eventData = '';

						for (const line of lines) {
							if (line.startsWith('event: ')) {
								eventType = line.slice(7);
							} else if (line.startsWith('data: ')) {
								eventData = line.slice(6);
							}
						}

						if (!eventData) continue;

						try {
							const data = JSON.parse(eventData);

							// Handle different Claude API event types
							if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
								accumulatedText += data.delta.text;
							} else if (data.type === 'message_stop') {
								// Message complete
								clearTimeout(killTimer);
								if (batchUpdateInterval) clearInterval(batchUpdateInterval);

								// Final update - always strip the marker comment
								if (accumulatedText) {
									const response = this.formatAsBlockquote(accumulatedText, responseStyle);
									this.updateStreamingMarker(editor, markerId, response, responseStyle);
								}

								resolve(accumulatedText);
							} else if (data.type === 'error') {
								clearTimeout(killTimer);
								if (batchUpdateInterval) clearInterval(batchUpdateInterval);
								reject(new Error(data.error?.message || 'Claude API error'));
							}
						} catch (e) {
							// Ignore JSON parse errors for incomplete chunks
							console.debug('Claude API SSE parse error:', e.message);
						}
					}
				});

				res.on('end', () => {
					clearTimeout(killTimer);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);

					// Final update - always strip the marker comment
					if (accumulatedText) {
						const response = this.formatAsBlockquote(accumulatedText, responseStyle);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
					}

					resolve(accumulatedText);
				});

				res.on('error', (error) => {
					clearTimeout(killTimer);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);
					reject(error);
				});
			});

			req.on('error', (error) => {
				clearTimeout(killTimer);
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				reject(new Error(`Claude API connection error: ${error.message}`));
			});

			// Set timeout
			killTimer = setTimeout(() => {
				req.destroy();
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				const timeoutMsg = `Claude API request timed out after ${timeout}ms. Check your internet connection or increase timeout in Settings → AtLine AI.`;
				reject(new Error(timeoutMsg));
			}, timeout);

			// Send the request
			req.write(requestData);
			req.end();
		});
	}

	/**
	 * Runs a streaming OpenAI API request and updates the editor in real-time.
	 * Uses direct OpenAI API instead of Codex CLI.
	 * @param {Editor} editor - Obsidian editor instance
	 * @param {string} markerId - Unique marker ID for tracking this response
	 * @param {string} contextInfo - File contents and context
	 * @param {string} question - The user's question
	 * @param {string} systemPrompt - System prompt for OpenAI
	 * @param {number} timeout - Timeout in milliseconds
	 * @param {string} responseStyle - Response formatting style
	 * @param {string} model - OpenAI model to use
	 * @returns {Promise<string>} The accumulated response text
	 */
	async runOpenAIApiStreaming(editor, markerId, contextInfo, question, systemPrompt = '', timeout = 120000, responseStyle = 'blockquote', model = null) {
		return new Promise((resolve, reject) => {
			const https = require('https');

			// Build messages array
			const messages = [];
			if (systemPrompt) {
				messages.push({ role: 'system', content: systemPrompt });
			}
			messages.push({ role: 'user', content: `${contextInfo}\n\nQuestion: ${question}` });

			const requestData = JSON.stringify({
				model: model || 'gpt-4o',
				messages: messages,
				stream: true
			});

			const options = {
				hostname: 'api.openai.com',
				path: '/v1/chat/completions',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this.settings.openaiApiKey}`,
					'Content-Length': Buffer.byteLength(requestData)
				}
			};

			let accumulatedText = '';
			let buffer = '';
			let lastFormattedText = '';
			let batchUpdateInterval = null;
			let killTimer;

			const req = https.request(options, (res) => {
				// Check for error status codes
				if (res.statusCode !== 200) {
					let errorBody = '';
					res.on('data', chunk => errorBody += chunk.toString());
					res.on('end', () => {
						clearTimeout(killTimer);
						let errorMsg = `OpenAI API error (${res.statusCode})`;
						try {
							const errorJson = JSON.parse(errorBody);
							errorMsg = errorJson.error?.message || errorMsg;
						} catch (e) {
							errorMsg = errorBody || errorMsg;
						}
						reject(new Error(errorMsg));
					});
					return;
				}

				// Batch editor updates every 100ms for performance
				batchUpdateInterval = setInterval(() => {
					if (accumulatedText && accumulatedText !== lastFormattedText) {
						// Pass markerId to keep it in the response for subsequent updates
						const response = this.formatAsBlockquote(accumulatedText, responseStyle, markerId);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
						lastFormattedText = accumulatedText;
					}
				}, 100);

				res.on('data', (chunk) => {
					buffer += chunk.toString();

					// Parse SSE format: "data: json\n\n"
					const lines = buffer.split('\n');
					buffer = '';

					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const data = line.slice(6);

							if (data === '[DONE]') {
								// Stream complete
								clearTimeout(killTimer);
								if (batchUpdateInterval) clearInterval(batchUpdateInterval);

								// Final update - always strip the marker comment
								if (accumulatedText) {
									const response = this.formatAsBlockquote(accumulatedText, responseStyle);
									this.updateStreamingMarker(editor, markerId, response, responseStyle);
								}

								resolve(accumulatedText);
								return;
							}

							try {
								const parsed = JSON.parse(data);
								const content = parsed.choices?.[0]?.delta?.content;
								if (content) {
									accumulatedText += content;
								}
							} catch (e) {
								// Ignore JSON parse errors for incomplete chunks
								buffer = line; // Keep for next iteration
							}
						} else if (line.trim() && !line.startsWith(':')) {
							// Keep non-empty, non-comment lines for next iteration
							buffer += line + '\n';
						}
					}
				});

				res.on('end', () => {
					clearTimeout(killTimer);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);

					// Final update - always strip the marker comment
					if (accumulatedText) {
						const response = this.formatAsBlockquote(accumulatedText, responseStyle);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
					}

					resolve(accumulatedText);
				});

				res.on('error', (error) => {
					clearTimeout(killTimer);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);
					reject(error);
				});
			});

			req.on('error', (error) => {
				clearTimeout(killTimer);
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				reject(new Error(`OpenAI API connection error: ${error.message}`));
			});

			// Set timeout
			killTimer = setTimeout(() => {
				req.destroy();
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				const timeoutMsg = `OpenAI API request timed out after ${timeout}ms. Check your internet connection or increase timeout in Settings → AtLine AI.`;
				reject(new Error(timeoutMsg));
			}, timeout);

			// Send the request
			req.write(requestData);
			req.end();
		});
	}

	/**
	 * Runs a query using the Gemini API directly with streaming.
	 * Uses Server-Sent Events for real-time response streaming.
	 */
	async runGeminiApiStreaming(editor, markerId, contextInfo, question, systemPrompt = '', timeout = 120000, responseStyle = 'blockquote', model = null) {
		return new Promise((resolve, reject) => {
			const https = require('https');

			// Build request body for Gemini API
			const requestBody = {
				contents: [{
					parts: [{ text: `${contextInfo}\n\nQuestion: ${question}` }]
				}]
			};

			// Add system instruction if provided
			if (systemPrompt) {
				requestBody.systemInstruction = {
					parts: [{ text: systemPrompt }]
				};
			}

			const requestData = JSON.stringify(requestBody);
			const modelName = model || 'gemini-2.0-flash';

			const options = {
				hostname: 'generativelanguage.googleapis.com',
				path: `/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${this.settings.geminiApiKey}`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(requestData)
				}
			};

			let accumulatedText = '';
			let buffer = '';
			let lastFormattedText = '';
			let batchUpdateInterval = null;
			let killTimer;

			const req = https.request(options, (res) => {
				// Check for error status codes
				if (res.statusCode !== 200) {
					let errorBody = '';
					res.on('data', chunk => errorBody += chunk.toString());
					res.on('end', () => {
						clearTimeout(killTimer);
						let errorMsg = `Gemini API error (${res.statusCode})`;
						try {
							const errorJson = JSON.parse(errorBody);
							errorMsg = errorJson.error?.message || errorMsg;
						} catch (e) {
							errorMsg = errorBody || errorMsg;
						}
						reject(new Error(errorMsg));
					});
					return;
				}

				// Batch editor updates every 100ms for performance
				batchUpdateInterval = setInterval(() => {
					if (accumulatedText && accumulatedText !== lastFormattedText) {
						// Pass markerId to keep it in the response for subsequent updates
						const response = this.formatAsBlockquote(accumulatedText, responseStyle, markerId);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
						lastFormattedText = accumulatedText;
					}
				}, 100);

				res.on('data', (chunk) => {
					buffer += chunk.toString();

					// Parse SSE format: "data: json\n\n"
					const lines = buffer.split('\n');
					buffer = '';

					for (const line of lines) {
						if (line.startsWith('data: ')) {
							const data = line.slice(6);

							try {
								const parsed = JSON.parse(data);
								// Gemini SSE format: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
								const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
								if (text) {
									accumulatedText += text;
								}
							} catch (e) {
								// Ignore JSON parse errors for incomplete chunks
								buffer = line; // Keep for next iteration
							}
						} else if (line.trim() && !line.startsWith(':')) {
							// Keep non-empty, non-comment lines for next iteration
							buffer += line + '\n';
						}
					}
				});

				res.on('end', () => {
					clearTimeout(killTimer);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);

					// Final update - always strip the marker comment
					if (accumulatedText) {
						const response = this.formatAsBlockquote(accumulatedText, responseStyle);
						this.updateStreamingMarker(editor, markerId, response, responseStyle);
					}

					resolve(accumulatedText);
				});

				res.on('error', (error) => {
					clearTimeout(killTimer);
					if (batchUpdateInterval) clearInterval(batchUpdateInterval);
					reject(error);
				});
			});

			req.on('error', (error) => {
				clearTimeout(killTimer);
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				reject(new Error(`Gemini API connection error: ${error.message}`));
			});

			// Set timeout
			killTimer = setTimeout(() => {
				req.destroy();
				if (batchUpdateInterval) clearInterval(batchUpdateInterval);
				const timeoutMsg = `Gemini API request timed out after ${timeout}ms. Check your internet connection or increase timeout in Settings → AtLine AI.`;
				reject(new Error(timeoutMsg));
			}, timeout);

			// Send the request
			req.write(requestData);
			req.end();
		});
	}

	formatAsBlockquote(text, styleOverride = null, markerId = null) {
		// Memoization: return cached result if text, style, and markerId unchanged (optimization #6)
		const style = styleOverride || this.settings.responseStyle || 'blockquote';
		if (this.formatCache.text === text && this.formatCache.style === style && this.formatCache.markerId === markerId) {
			return this.formatCache.result;
		}

		// Marker comment for streaming updates (hidden in rendered markdown)
		const markerComment = markerId ? ` <!-- ${markerId} -->` : '';

		// Format text based on user's response style preference
		let result;
		switch (style) {
			case 'blockquote':
				// Traditional blockquote format (> prefix) - optimized with .replace()
				result = `\n\n> ${text.replace(/\n/g, '\n> ')}${markerComment}\n`;
				break;

			case 'callout':
				// Obsidian callout box format - optimized with .replace()
				result = `\n\n> [!info]+ AI Response\n> ${text.replace(/\n/g, '\n> ')}${markerComment}\n`;
				break;

			case 'plain':
				// Plain text with separator
				result = `\n\n---\n\n${text}${markerComment}\n\n---\n`;
				break;

			case 'code':
				// Code block format
				result = `\n\n\`\`\`\n${text}${markerComment}\n\`\`\`\n`;
				break;

			case 'custom':
				// User-defined custom format
				const format = this.settings.customResponseFormat || '> {response}';
				// Replace {response} placeholder with the actual text
				// Also support {response_blockquote} for blockquote-formatted response
				result = '\n\n' + format
					.replace(/\{response\}/g, text + markerComment)
					.replace(/\{response_blockquote\}/g, text.replace(/\n/g, '\n> ') + markerComment)
					+ '\n';
				break;

			default:
				// Fallback to blockquote
				result = `\n\n> ${text.replace(/\n/g, '\n> ')}${markerComment}\n`;
		}

		// Cache the result for future calls
		this.formatCache = { text, result, style, markerId };
		return result;
	}

	updateStreamingMarker(editor, markerId, replacement, styleOverride = null) {
		// Find and replace the streaming marker using a position-based approach
		// This is more reliable than complex regex for multi-line content
		const doc = editor.getValue();
		const markerComment = `<!-- ${markerId} -->`;
		const markerIndex = doc.indexOf(markerComment);

		if (markerIndex === -1) {
			console.warn(`Streaming marker ${markerId} not found in document`);
			return;
		}

		const style = styleOverride || this.settings.responseStyle || 'blockquote';

		// Find the start of the response block by searching backwards
		let startIndex = markerIndex;

		switch (style) {
			case 'blockquote':
			case 'callout':
				// Search backwards for \n\n> (start of blockquote)
				const blockquoteStart = doc.lastIndexOf('\n\n>', markerIndex);
				if (blockquoteStart !== -1) {
					startIndex = blockquoteStart;
				}
				break;
			case 'plain':
				// Search backwards for \n\n---\n\n
				const plainStart = doc.lastIndexOf('\n\n---\n\n', markerIndex);
				if (plainStart !== -1) {
					startIndex = plainStart;
				}
				break;
			case 'code':
				// Search backwards for \n\n```\n
				const codeStart = doc.lastIndexOf('\n\n```\n', markerIndex);
				if (codeStart !== -1) {
					startIndex = codeStart;
				}
				break;
		}

		// Find the end of the response block
		let endIndex = markerIndex + markerComment.length;

		switch (style) {
			case 'blockquote':
				// End after the newline following the marker
				if (doc[endIndex] === '\n') endIndex++;
				break;
			case 'callout':
				// End after the newline following the marker
				if (doc[endIndex] === '\n') endIndex++;
				break;
			case 'plain':
				// End after \n\n---\n
				const plainEndMarker = '\n\n---\n';
				if (doc.substring(endIndex, endIndex + plainEndMarker.length) === plainEndMarker) {
					endIndex += plainEndMarker.length;
				} else if (doc[endIndex] === '\n') {
					endIndex++;
				}
				break;
			case 'code':
				// End after \n```\n
				const codeEndMarker = '\n```\n';
				if (doc.substring(endIndex, endIndex + codeEndMarker.length) === codeEndMarker) {
					endIndex += codeEndMarker.length;
				} else if (doc[endIndex] === '\n') {
					endIndex++;
				}
				break;
		}

		// Replace the range
		const startPos = editor.offsetToPos(startIndex);
		const endPos = editor.offsetToPos(endIndex);
		editor.replaceRange(replacement, startPos, endPos);
	}

	/**
	 * Replaces the loading marker with the final AI response.
	 * Handles all response styles (blockquote, callout, plain, code).
	 * @param {Editor} editor - Obsidian editor instance
	 * @param {string} markerId - Unique marker ID to find and replace
	 * @param {string} replacement - Formatted response text to insert
	 * @returns {void}
	 */
	replaceLoadingMarker(editor, markerId, replacement) {
		// Match any provider name (Claude, Gemini, etc.) - use efficient targeted replacement
		const style = this.settings.responseStyle || 'blockquote';
		let markerRegex;

		switch (style) {
			case 'blockquote':
				markerRegex = new RegExp(`\\n\\n> [⏳⌛] \\*\\w+ is thinking\\.+\\* <!-- ${markerId} -->\\n`);
				break;
			case 'callout':
				markerRegex = new RegExp(`\\n\\n> \\[!info\\]\\+ \\w+\\n> [⏳⌛] \\*\\w+ is thinking\\.+\\* <!-- ${markerId} -->\\n`);
				break;
			case 'plain':
				markerRegex = new RegExp(`\\n\\n---\\n\\n[⏳⌛] \\*\\w+ is thinking\\.+\\* <!-- ${markerId} -->\\n\\n---\\n`);
				break;
			case 'code':
				markerRegex = new RegExp(`\\n\\n\`\`\`\\n[⏳⌛] \\*\\w+ is thinking\\.+\\* <!-- ${markerId} -->\\n\`\`\`\\n`);
				break;
			default:
				markerRegex = new RegExp(`\\n\\n> [⏳⌛] \\*\\w+ is thinking\\.+\\* <!-- ${markerId} -->\\n`);
		}

		const found = this.replaceInDocument(editor, markerRegex, replacement);

		if (!found) {
			// Marker not found, append at the end
			console.warn(`Loading marker ${markerId} not found, appending response`);
			editor.replaceRange(replacement, editor.getCursor());
		}
	}

	onunload() {
		const styleEl = document.getElementById('atline-ai-loading-styles');
		if (styleEl) styleEl.remove();
	}
};

class AtLineAISettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		// Track which agents are expanded (by alias)
		this.expandedAgents = new Set();
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		// ─────────────────────────────────────────────────────────────
		// AI Agents
		// ─────────────────────────────────────────────────────────────
		const agentsSection = containerEl.createDiv('atline-ai-section');
		agentsSection.createEl('h2', {
			text: 'AI Agents',
			attr: { style: 'font-size: 1.2em; margin-bottom: 0.5em;' }
		});
		agentsSection.createEl('p', {
			text: 'Configure AI agents. Use @alias in notes to trigger queries.',
			cls: 'setting-item-description'
		});

		// Display existing agents
		this.plugin.settings.agents.forEach((agent, index) => {
			const agentCard = agentsSection.createDiv('atline-ai-agent-card');

			// Agent header with alias and provider badge (clickable to expand/collapse)
			const header = agentCard.createDiv('atline-ai-agent-header-clickable');
			const titleDiv = header.createDiv('atline-ai-agent-title');
			const aliasSpan = titleDiv.createEl('span', { text: `@${agent.alias}`, cls: 'atline-ai-agent-alias' });
			const providerDisplayName = agent.provider === 'codex' ? 'OpenAI' : agent.provider;
			const providerBadge = titleDiv.createEl('span', {
				text: providerDisplayName,
				cls: `atline-ai-provider-badge atline-ai-provider-${agent.provider}`
			});
			const expandIcon = header.createDiv('atline-ai-expand-icon');

			// Content section
			const content = agentCard.createDiv('atline-ai-agent-content');

			// Check if this agent should be expanded (persisted across re-renders)
			const shouldBeExpanded = this.expandedAgents.has(agent.alias);
			content.style.display = shouldBeExpanded ? 'block' : 'none';
			expandIcon.textContent = shouldBeExpanded ? '▲' : '▼';
			if (shouldBeExpanded) {
				agentCard.addClass('atline-ai-agent-expanded');
			}

			// Toggle expand/collapse
			header.addEventListener('click', () => {
				const isExpanded = content.style.display !== 'none';
				content.style.display = isExpanded ? 'none' : 'block';
				expandIcon.textContent = isExpanded ? '▼' : '▲';
				agentCard.toggleClass('atline-ai-agent-expanded', !isExpanded);
				// Track expanded state
				if (isExpanded) {
					this.expandedAgents.delete(agent.alias);
				} else {
					this.expandedAgents.add(agent.alias);
				}
			});

			// Alias setting
			new Setting(content)
				.setName('Alias')
				.setDesc('Trigger word to use in notes')
				.addText(text => text
					.setValue(agent.alias)
					.onChange(async (value) => {
						// Validate alias format
						const trimmedValue = value.trim();
						if (!trimmedValue) {
							new Notice('Alias cannot be empty');
							return;
						}
						if (!/^[a-zA-Z0-9-_]+$/.test(trimmedValue)) {
							new Notice('Alias can only contain letters, numbers, hyphens, and underscores');
							return;
						}

						// Check for duplicate aliases
						const isDuplicate = this.plugin.settings.agents.some((a, i) =>
							i !== index && a.alias === trimmedValue
						);

						if (isDuplicate) {
							new Notice(`Alias "@${trimmedValue}" is already in use. Please choose a different alias.`);
							return;
						}

						// Update expanded state tracking with new alias
						if (this.expandedAgents.has(agent.alias)) {
							this.expandedAgents.delete(agent.alias);
							this.expandedAgents.add(trimmedValue);
						}
						this.plugin.settings.agents[index].alias = trimmedValue;
						// Update header text immediately
						aliasSpan.textContent = `@${trimmedValue}`;
						await this.plugin.saveSettings();
					}));

			// Provider setting
			new Setting(content)
				.setName('Provider')
				.setDesc('AI provider to use')
				.addDropdown(dropdown => dropdown
					.addOption('claude', 'Claude')
					.addOption('gemini', 'Gemini')
					.addOption('ollama', 'Ollama')
					.addOption('codex', 'OpenAI')
					.setValue(agent.provider)
					.onChange(async (value) => {
						this.plugin.settings.agents[index].provider = value;
						// Update badge immediately (show 'openai' instead of 'codex')
						providerBadge.textContent = value === 'codex' ? 'OpenAI' : value;
						providerBadge.className = `atline-ai-provider-badge atline-ai-provider-${value}`;
						await this.plugin.saveSettings();
						// Re-render to show/hide connection mode
						this.display();
					}));

			// Connection Mode setting (only for Claude provider)
			if (agent.provider === 'claude') {
				const connectionModeSetting = new Setting(content)
					.setName('Connection mode')
					.setDesc('CLI requires Claude CLI installed. API requires API key configured in API Keys section.')
					.addDropdown(dropdown => dropdown
						.addOption('cli', 'CLI (Claude Code)')
						.addOption('api', 'API (Direct)')
						.setValue(agent.connectionMode || 'cli')
						.onChange(async (value) => {
							this.plugin.settings.agents[index].connectionMode = value;
							await this.plugin.saveSettings();
							// Re-render to show/hide API key warning
							this.display();
						}));

				// Show warning if API selected but no key configured
				if (agent.connectionMode === 'api' && !this.plugin.settings.claudeApiKey) {
					const warningEl = content.createEl('div', {
						cls: 'setting-item-description',
						attr: { style: 'color: var(--text-warning); margin-top: -10px; margin-bottom: 10px; padding-left: 18px;' }
					});
					warningEl.appendText('⚠️ API key not configured. Add your Anthropic API key in the ');
				warningEl.createEl('strong', { text: 'API Keys' });
				warningEl.appendText(' section below.');
				}
			}

			// Connection Mode setting (only for OpenAI provider)
			if (agent.provider === 'codex') {
				const connectionModeSetting = new Setting(content)
					.setName('Connection mode')
					.setDesc('CLI requires Codex CLI installed. API requires OpenAI API key in API Keys section.')
					.addDropdown(dropdown => dropdown
						.addOption('cli', 'CLI (Codex)')
						.addOption('api', 'API (Direct)')
						.setValue(agent.connectionMode || 'cli')
						.onChange(async (value) => {
							this.plugin.settings.agents[index].connectionMode = value;
							await this.plugin.saveSettings();
							// Re-render to show/hide API key warning
							this.display();
						}));

				// Show warning if API selected but no key configured
				if (agent.connectionMode === 'api' && !this.plugin.settings.openaiApiKey) {
					const warningEl = content.createEl('div', {
						cls: 'setting-item-description',
						attr: { style: 'color: var(--text-warning); margin-top: -10px; margin-bottom: 10px; padding-left: 18px;' }
					});
					warningEl.appendText('⚠️ API key not configured. Add your OpenAI API key in the ');
				warningEl.createEl('strong', { text: 'API Keys' });
				warningEl.appendText(' section below.');
				}
			}

			// Connection Mode setting (only for Gemini provider)
			if (agent.provider === 'gemini') {
				const connectionModeSetting = new Setting(content)
					.setName('Connection mode')
					.setDesc('CLI requires Gemini CLI installed. API requires Google AI API key configured in API Keys section.')
					.addDropdown(dropdown => dropdown
						.addOption('cli', 'CLI (Gemini)')
						.addOption('api', 'API (Direct)')
						.setValue(agent.connectionMode || 'cli')
						.onChange(async (value) => {
							this.plugin.settings.agents[index].connectionMode = value;
							await this.plugin.saveSettings();
							// Re-render to show/hide API key warning
							this.display();
						}));

				// Show warning if API selected but no key configured
				if (agent.connectionMode === 'api' && !this.plugin.settings.geminiApiKey) {
					const warningEl = content.createEl('div', {
						cls: 'setting-item-description',
						attr: { style: 'color: var(--text-warning); margin-top: -10px; margin-bottom: 10px; padding-left: 18px;' }
					});
					warningEl.appendText('⚠️ API key not configured. Add your Google AI API key in the ');
				warningEl.createEl('strong', { text: 'API Keys' });
				warningEl.appendText(' section below.');
				}
			}

			// Model setting - show appropriate default based on provider and connection mode
			const getDefaultModel = (provider, connectionMode) => {
				if (provider === 'claude') {
					return connectionMode === 'api' ? 'claude-sonnet-4-20250514' : '';
				} else if (provider === 'codex') {
					return connectionMode === 'api' ? 'gpt-4o' : '';
				} else if (provider === 'ollama') {
					return 'llama2';
				} else if (provider === 'gemini') {
					return connectionMode === 'api' ? 'gemini-2.0-flash' : '';
				}
				return '';
			};
			const defaultModel = getDefaultModel(agent.provider, agent.connectionMode);

			new Setting(content)
				.setName('Model')
				.setDesc(`Specify model for this agent. ${agent.connectionMode === 'api' ? 'Required for API mode.' : 'Leave empty to use CLI default.'}`)
				.addText(text => text
					.setPlaceholder(defaultModel || 'Default model')
					.setValue(agent.model || '')
					.onChange(async (value) => {
						this.plugin.settings.agents[index].model = value.trim() === '' ? undefined : value.trim();
						await this.plugin.saveSettings();
					}));

			// Plot Library setting (only for @plot agent)
			if (agent.alias === 'plot') {
				new Setting(content)
					.setName('Plot library')
					.setDesc('Choose which plotting plugin to generate code for. You must install the corresponding Obsidian plugin.')
					.addDropdown(dropdown => dropdown
						.addOption('charts', 'Charts (Chart.js)')
						.addOption('desmos', 'Desmos')
						.addOption('functionplot', 'Function Plot')
						.setValue(agent.plotLibrary || 'charts')
						.onChange(async (value) => {
							this.plugin.settings.agents[index].plotLibrary = value;
							await this.plugin.saveSettings();
							// Update the notice text
							this.display();
						}));

				// Add notice about required plugin
				const requiredPlugin = PLOT_LIBRARY_PLUGINS[agent.plotLibrary || 'charts'];
				const noticeEl = content.createEl('div', {
					cls: 'setting-item-description',
					attr: { style: 'margin-top: -10px; margin-bottom: 10px; padding-left: 18px; color: var(--text-accent);' }
				});
				noticeEl.appendText('⚠️ Requires ');
			noticeEl.createEl('strong', { text: requiredPlugin });
			noticeEl.appendText(' plugin to be installed in Obsidian.');
			}

			// System Prompt setting (optimized: no re-render on change)
			// For @plot, show that prompt is auto-generated
			const isPlotAgent = agent.alias === 'plot';
			new Setting(content)
				.setName('System prompt')
				.setDesc(isPlotAgent ? 'Auto-generated based on Plot Library selection. You can override it here.' : 'Custom instructions for this agent')
				.addTextArea(text => {
					text.inputEl.classList.add('atline-ai-system-prompt');
					// For @plot agent, show the effective prompt (from library) but allow override
					const effectivePrompt = isPlotAgent && !agent.systemPrompt && agent.plotLibrary
						? PLOT_LIBRARY_PROMPTS[agent.plotLibrary] || ''
						: agent.systemPrompt;
					text.setValue(effectivePrompt)
						.setPlaceholder(isPlotAgent ? 'Leave empty to use auto-generated prompt for selected library' : '')
						.onChange(async (value) => {
							this.plugin.settings.agents[index].systemPrompt = value;
							// Don't await or re-render - just save in background for better performance
							this.plugin.saveSettings();
						});
				});

			// Include All Wikilinks toggle
			new Setting(content)
				.setName('Include all wikilinks')
				.setDesc('Pass all [[wikilinks]] from the current file to the AI (not just from the query). Useful when you have reference files at the top of your note.')
				.addToggle(toggle => toggle
					.setValue(agent.includeAllWikilinks ?? false)
					.onChange(async (value) => {
						this.plugin.settings.agents[index].includeAllWikilinks = value;
						await this.plugin.saveSettings();
					}));

			// Delete Query After Response toggle
			new Setting(content)
				.setName('Delete query after response')
				.setDesc('Automatically remove the @agent query line after the AI response is shown.')
				.addToggle(toggle => toggle
					.setValue(agent.deleteQueryAfterResponse ?? false)
					.onChange(async (value) => {
						this.plugin.settings.agents[index].deleteQueryAfterResponse = value;
						await this.plugin.saveSettings();
					}));

			// Timeout override
			new Setting(content)
				.setName('Timeout override')
				.setDesc('Override global timeout for this agent (in milliseconds). Leave empty to use global setting.')
				.addText(text => text
					.setPlaceholder('Use global setting')
					.setValue(agent.timeout ? agent.timeout.toString() : '')
					.onChange(async (value) => {
						if (value.trim() === '') {
							this.plugin.settings.agents[index].timeout = undefined;
						} else {
							const timeout = parseInt(value);
							if (!isNaN(timeout) && timeout > 0) {
								this.plugin.settings.agents[index].timeout = timeout;
							}
						}
						await this.plugin.saveSettings();
					}));

			// Response Style override
			new Setting(content)
				.setName('Response style override')
				.setDesc('Override global response style for this agent. Leave as "Use global" to use global setting.')
				.addDropdown(dropdown => dropdown
					.addOption('', 'Use global setting')
					.addOption('blockquote', 'Blockquote')
					.addOption('callout', 'Callout')
					.addOption('plain', 'Plain')
					.addOption('code', 'Code Block')
					.addOption('custom', 'Custom Format')
					.setValue(agent.responseStyle || '')
					.onChange(async (value) => {
						this.plugin.settings.agents[index].responseStyle = value === '' ? undefined : value;
						await this.plugin.saveSettings();
					}));

			// Test Connection button
			new Setting(content)
				.setName('Test connection')
				.setDesc('Verify this agent is configured correctly and can connect')
				.addButton(button => button
					.setButtonText('Test')
					.onClick(async () => {
						await this.plugin.testConnection(agent.provider, agent);
					}));

			// Delete button
			new Setting(content)
				.addButton(button => button
					.setButtonText('Delete Agent')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.agents.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					}));
		});

		// Add new agent button
		new Setting(agentsSection)
			.setName('Add new agent')
			.setDesc('Create a new AI agent with custom configuration')
			.addButton(button => button
				.setButtonText('+ Add Agent')
				.setCta()
				.onClick(async () => {
					// Generate unique alias
					let newAlias = 'new-agent';
					let counter = 1;
					const existingAliases = new Set(this.plugin.settings.agents.map(a => a.alias));

					while (existingAliases.has(newAlias)) {
						newAlias = `new-agent-${counter}`;
						counter++;
					}

					this.plugin.settings.agents.push({
						alias: newAlias,
						provider: 'claude',
						systemPrompt: 'You are a helpful AI assistant.'
					});
					await this.plugin.saveSettings();
					this.display();
				}));

		// ─────────────────────────────────────────────────────────────
		// General Settings
		// ─────────────────────────────────────────────────────────────
		const generalSection = containerEl.createDiv('atline-ai-section');
		generalSection.createEl('h2', {
			text: 'General Settings',
			attr: { style: 'font-size: 1.2em; margin-bottom: 0.5em;' }
		});

		new Setting(generalSection)
			.setName('Response style')
			.setDesc('How AI responses appear in your notes')
			.addDropdown(dropdown => dropdown
				.addOption('blockquote', 'Blockquote (> prefix)')
				.addOption('callout', 'Callout Box (info box)')
				.addOption('plain', 'Plain Text (with separators)')
				.addOption('code', 'Code Block (monospace)')
				.addOption('custom', 'Custom Format')
				.setValue(this.plugin.settings.responseStyle || 'callout')
				.onChange(async (value) => {
					this.plugin.settings.responseStyle = value;
					await this.plugin.saveSettings();
					// Show/hide custom format editor and preview
					const isCustom = value === 'custom';
					customFormatContainer.style.display = isCustom ? 'block' : 'none';
					previewContainer.style.display = isCustom ? 'none' : 'block';
					if (!isCustom) {
						this.updateStylePreview(previewContainer, value);
					}
				}));

		// Custom format container (shown only when 'custom' is selected)
		const customFormatContainer = generalSection.createDiv('atline-ai-custom-format');
		const isCustom = this.plugin.settings.responseStyle === 'custom';
		customFormatContainer.style.display = isCustom ? 'block' : 'none';

		// Custom format editor
		new Setting(customFormatContainer)
			.setName('Custom format')
			.setDesc('Use {response} as placeholder for AI output. Use {response_blockquote} for blockquote-formatted output.')
			.addTextArea(text => {
				text.inputEl.style.width = '100%';
				text.inputEl.style.height = '80px';
				text.inputEl.style.fontFamily = 'monospace';
				text.setValue(this.plugin.settings.customResponseFormat || '> **AI:** {response}')
					.setPlaceholder('> **AI:** {response}')
					.onChange(async (value) => {
						this.plugin.settings.customResponseFormat = value;
						await this.plugin.saveSettings();
					});
			});

		// Preview container (hidden when custom is selected)
		const previewContainer = generalSection.createDiv('response-style-preview');
		previewContainer.style.display = isCustom ? 'none' : 'block';
		previewContainer.createEl('div', { text: 'Preview:', cls: 'response-style-preview-label' });
		previewContainer.createDiv('response-style-preview-content');
		if (!isCustom) {
			this.updateStylePreview(previewContainer, this.plugin.settings.responseStyle || 'callout');
		}

		// Spacer after preview
		generalSection.createDiv({ attr: { style: 'height: 1em;' } });

		new Setting(generalSection)
			.setName('Timeout')
			.setDesc('Maximum wait time for AI response (milliseconds)')
			.addText(text => text
				.setPlaceholder('120000')
				.setValue(String(this.plugin.settings.timeout))
				.onChange(async (value) => {
					const timeout = parseInt(value, 10);
					if (isNaN(timeout)) {
						new Notice('Timeout must be a valid number');
						return;
					}
					if (timeout < 1000) {
						new Notice('Timeout must be at least 1000ms (1 second)');
						this.plugin.settings.timeout = 1000;
						await this.plugin.saveSettings();
						text.setValue('1000');
						return;
					}
					if (timeout > 600000) {
						new Notice('Timeout cannot exceed 600000ms (10 minutes)');
						this.plugin.settings.timeout = 600000;
						await this.plugin.saveSettings();
						text.setValue('600000');
						return;
					}
					this.plugin.settings.timeout = timeout;
					await this.plugin.saveSettings();
				}));

		// ─────────────────────────────────────────────────────────────
		// Ollama Settings (collapsible, same style as agent cards)
		// ─────────────────────────────────────────────────────────────
		const ollamaCard = containerEl.createDiv('atline-ai-agent-card');
		const ollamaHeader = ollamaCard.createDiv('atline-ai-agent-header-clickable');
		const ollamaTitleDiv = ollamaHeader.createDiv('atline-ai-agent-title');
		ollamaTitleDiv.createEl('span', { text: 'Ollama Settings', cls: 'atline-ai-agent-alias' });
		const ollamaExpandIcon = ollamaHeader.createDiv('atline-ai-expand-icon');
		ollamaExpandIcon.textContent = '▼';
		const ollamaContent = ollamaCard.createDiv('atline-ai-agent-content');
		ollamaContent.style.display = 'none';

		ollamaHeader.addEventListener('click', () => {
			const isExpanded = ollamaContent.style.display !== 'none';
			ollamaContent.style.display = isExpanded ? 'none' : 'block';
			ollamaExpandIcon.textContent = isExpanded ? '▼' : '▲';
			ollamaCard.toggleClass('atline-ai-agent-expanded', !isExpanded);
		});

		ollamaContent.createEl('p', {
			text: 'For local AI models. Ensure Ollama is running before use.',
			cls: 'setting-item-description'
		});

		new Setting(ollamaContent)
			.setName('Base URL')
			.setDesc('Ollama server address')
			.addText(text => text
				.setPlaceholder('http://localhost:11434')
				.setValue(this.plugin.settings.ollamaBaseUrl)
				.onChange(async (value) => {
					const url = value.trim() || 'http://localhost:11434';
					if (!url.match(/^https?:\/\/.+/)) {
						new Notice('URL must start with http:// or https://');
						return;
					}
					this.plugin.settings.ollamaBaseUrl = url;
					await this.plugin.saveSettings();
				}));

		// ─────────────────────────────────────────────────────────────
		// CLI Paths (collapsible, same style as agent cards)
		// ─────────────────────────────────────────────────────────────
		const cliCard = containerEl.createDiv('atline-ai-agent-card');
		const cliHeader = cliCard.createDiv('atline-ai-agent-header-clickable');
		const cliTitleDiv = cliHeader.createDiv('atline-ai-agent-title');
		cliTitleDiv.createEl('span', { text: 'CLI Paths', cls: 'atline-ai-agent-alias' });
		const cliExpandIcon = cliHeader.createDiv('atline-ai-expand-icon');
		cliExpandIcon.textContent = '▼';
		const cliContent = cliCard.createDiv('atline-ai-agent-content');
		cliContent.style.display = 'none';

		cliHeader.addEventListener('click', () => {
			const isExpanded = cliContent.style.display !== 'none';
			cliContent.style.display = isExpanded ? 'none' : 'block';
			cliExpandIcon.textContent = isExpanded ? '▼' : '▲';
			cliCard.toggleClass('atline-ai-agent-expanded', !isExpanded);
		});

		cliContent.createEl('p', {
			text: 'Auto-detected from shell environment on startup.',
			cls: 'setting-item-description'
		});

		new Setting(cliContent)
			.setName('Auto-detect')
			.setDesc('Re-scan shell environment for CLI paths')
			.addButton(button => button
				.setButtonText('Re-detect Paths')
				.onClick(async () => {
					button.setButtonText('Detecting...');
					button.setDisabled(true);
					this.plugin.settings.nodePath = 'node';
					this.plugin.settings.claudePath = 'claude';
					this.plugin.settings.geminiPath = 'gemini';
					this.plugin.settings.codexPath = 'codex';
					await this.plugin.autoDetectCliPaths();
					this.display();
					new Notice('CLI paths re-detected');
				}));

		new Setting(cliContent)
			.setName('Node.js')
			.setDesc('Required for Gemini and Codex CLI (Node 20+ recommended). Not used for Claude when "native binary" is enabled.')
			.addText(text => text
				.setPlaceholder('node')
				.setValue(this.plugin.settings.nodePath)
				.onChange(async (value) => {
					this.plugin.settings.nodePath = value || 'node';
					await this.plugin.saveSettings();
				}));

		new Setting(cliContent)
			.setName('Claude CLI')
			.addText(text => text
				.setPlaceholder('claude')
				.setValue(this.plugin.settings.claudePath)
				.onChange(async (value) => {
					this.plugin.settings.claudePath = value || 'claude';
					await this.plugin.saveSettings();
				}));

		new Setting(cliContent)
			.setName('Claude is a native binary')
			.setDesc('Run claude directly without node (required for Claude CLI v2+). Uncheck only if using an older script-based install.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.claudeDirectExec)
				.onChange(async (value) => {
					this.plugin.settings.claudeDirectExec = value;
					await this.plugin.saveSettings();
				}));

		new Setting(cliContent)
			.setName('Gemini CLI')
			.addText(text => text
				.setPlaceholder('gemini')
				.setValue(this.plugin.settings.geminiPath)
				.onChange(async (value) => {
					this.plugin.settings.geminiPath = value || 'gemini';
					await this.plugin.saveSettings();
				}));

		new Setting(cliContent)
			.setName('Codex CLI')
			.addText(text => text
				.setPlaceholder('codex')
				.setValue(this.plugin.settings.codexPath)
				.onChange(async (value) => {
					this.plugin.settings.codexPath = value || 'codex';
					await this.plugin.saveSettings();
				}));

		// ─────────────────────────────────────────────────────────────
		// API Keys (collapsible, same style as agent cards)
		// ─────────────────────────────────────────────────────────────
		const apiCard = containerEl.createDiv('atline-ai-agent-card');
		const apiHeader = apiCard.createDiv('atline-ai-agent-header-clickable');
		const apiTitleDiv = apiHeader.createDiv('atline-ai-agent-title');
		apiTitleDiv.createEl('span', { text: 'API Keys', cls: 'atline-ai-agent-alias' });
		const apiExpandIcon = apiHeader.createDiv('atline-ai-expand-icon');
		apiExpandIcon.textContent = '▼';
		const apiContent = apiCard.createDiv('atline-ai-agent-content');
		apiContent.style.display = 'none';

		apiHeader.addEventListener('click', () => {
			const isExpanded = apiContent.style.display !== 'none';
			apiContent.style.display = isExpanded ? 'none' : 'block';
			apiExpandIcon.textContent = isExpanded ? '▼' : '▲';
			apiCard.toggleClass('atline-ai-agent-expanded', !isExpanded);
		});

		apiContent.createEl('p', {
			text: 'Use API keys for direct API access instead of CLI. Set agent Connection Mode to "API" to use these.',
			cls: 'setting-item-description'
		});

		// Anthropic API Key setting with inline test button
		new Setting(apiContent)
			.setName('Anthropic API key')
			.setDesc('For Claude API access. Get your key from console.anthropic.com')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.width = '250px';
				text.setPlaceholder('sk-ant-...')
					.setValue(this.plugin.settings.claudeApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.claudeApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					if (!this.plugin.settings.claudeApiKey) {
						new Notice('Please enter an API key first');
						return;
					}
					button.setButtonText('Testing...');
					button.setDisabled(true);
					try {
						const https = require('https');
						const requestData = JSON.stringify({
							model: 'claude-sonnet-4-20250514',
							max_tokens: 10,
							messages: [{ role: 'user', content: 'Say "OK"' }]
						});

						const result = await new Promise((resolve, reject) => {
							const req = https.request({
								hostname: 'api.anthropic.com',
								path: '/v1/messages',
								method: 'POST',
								headers: {
									'Content-Type': 'application/json',
									'x-api-key': this.plugin.settings.claudeApiKey,
									'anthropic-version': '2023-06-01'
								}
							}, (res) => {
								let data = '';
								res.on('data', chunk => data += chunk);
								res.on('end', () => {
									if (res.statusCode === 200) {
										resolve('success');
									} else {
										try {
											const error = JSON.parse(data);
											reject(new Error(error.error?.message || `HTTP ${res.statusCode}`));
										} catch {
											reject(new Error(`HTTP ${res.statusCode}`));
										}
									}
								});
							});
							req.on('error', reject);
							req.write(requestData);
							req.end();
						});

						new Notice('✓ Claude API key is valid!', 3000);
					} catch (error) {
						new Notice(`✗ API test failed: ${error.message}`, 5000);
					} finally {
						button.setButtonText('Test');
						button.setDisabled(false);
					}
				}));

		// OpenAI API Key setting with inline test button
		new Setting(apiContent)
			.setName('OpenAI API key')
			.setDesc('For OpenAI API access. Get your key from platform.openai.com')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.width = '250px';
				text.setPlaceholder('sk-...')
					.setValue(this.plugin.settings.openaiApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.openaiApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					if (!this.plugin.settings.openaiApiKey) {
						new Notice('Please enter an API key first');
						return;
					}
					button.setButtonText('Testing...');
					button.setDisabled(true);
					try {
						const https = require('https');
						const requestData = JSON.stringify({
							model: 'gpt-4o-mini',
							max_tokens: 10,
							messages: [{ role: 'user', content: 'Say "OK"' }]
						});

						const result = await new Promise((resolve, reject) => {
							const req = https.request({
								hostname: 'api.openai.com',
								path: '/v1/chat/completions',
								method: 'POST',
								headers: {
									'Content-Type': 'application/json',
									'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`
								}
							}, (res) => {
								let data = '';
								res.on('data', chunk => data += chunk);
								res.on('end', () => {
									if (res.statusCode === 200) {
										resolve('success');
									} else {
										try {
											const error = JSON.parse(data);
											reject(new Error(error.error?.message || `HTTP ${res.statusCode}`));
										} catch {
											reject(new Error(`HTTP ${res.statusCode}`));
										}
									}
								});
							});
							req.on('error', reject);
							req.write(requestData);
							req.end();
						});

						new Notice('✓ OpenAI API key is valid!', 3000);
					} catch (error) {
						new Notice(`✗ API test failed: ${error.message}`, 5000);
					} finally {
						button.setButtonText('Test');
						button.setDisabled(false);
					}
				}));

		// Gemini API Key setting with test button
		new Setting(apiContent)
			.setName('Google AI API key')
			.setDesc('For Gemini API access. Get your key from aistudio.google.com')
			.addText(text => {
				text.inputEl.type = 'password';
				text.inputEl.style.width = '250px';
				text.setPlaceholder('AIza...')
					.setValue(this.plugin.settings.geminiApiKey || '')
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					if (!this.plugin.settings.geminiApiKey) {
						new Notice('Please enter an API key first');
						return;
					}
					button.setButtonText('Testing...');
					button.setDisabled(true);
					try {
						const https = require('https');
						const requestData = JSON.stringify({
							contents: [{ parts: [{ text: 'Say "OK"' }] }]
						});

						const result = await new Promise((resolve, reject) => {
							const req = https.request({
								hostname: 'generativelanguage.googleapis.com',
								path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${this.plugin.settings.geminiApiKey}`,
								method: 'POST',
								headers: {
									'Content-Type': 'application/json'
								}
							}, (res) => {
								let data = '';
								res.on('data', chunk => data += chunk);
								res.on('end', () => {
									if (res.statusCode === 200) {
										resolve('success');
									} else {
										try {
											const error = JSON.parse(data);
											reject(new Error(error.error?.message || `HTTP ${res.statusCode}`));
										} catch {
											reject(new Error(`HTTP ${res.statusCode}`));
										}
									}
								});
							});
							req.on('error', reject);
							req.write(requestData);
							req.end();
						});

						new Notice('✓ Gemini API key is valid!', 3000);
					} catch (error) {
						new Notice(`✗ API test failed: ${error.message}`, 5000);
					} finally {
						button.setButtonText('Test');
						button.setDisabled(false);
					}
				}));
	}

	/**
	 * Updates the visual preview of how AI responses will appear in the selected style.
	 * Called when the user changes the Response Style dropdown in settings.
	 * @param {HTMLElement} container - Container element for the preview
	 * @param {string} style - Response style: 'blockquote', 'callout', 'plain', or 'code'
	 * @returns {void}
	 */
	updateStylePreview(container, style) {
		// Clear existing preview
		const existingPreview = container.querySelector('.response-style-preview-sample');
		if (existingPreview) {
			existingPreview.remove();
		}

		// Create sample response text
		const sampleText = 'This is a sample AI response. It shows how your responses will appear in your notes.';
		const previewSample = container.createDiv('response-style-preview-sample');

		// Render based on style
		switch (style) {
			case 'blockquote': {
				const bq = previewSample.createEl('blockquote');
				bq.style.cssText = 'border-left: 2px solid var(--interactive-accent); padding-left: 1em; margin: 0.5em 0;';
				bq.appendText(sampleText);
				break;
			}
			case 'callout': {
				const div = previewSample.createDiv();
				div.style.cssText = 'background: var(--background-secondary); border-left: 3px solid var(--interactive-accent); padding: 1em; margin: 0.5em 0; border-radius: 4px;';
				div.createEl('strong', { text: 'AI Response' });
				div.createEl('br');
				div.appendText(sampleText);
				break;
			}
			case 'plain': {
				const wrap = previewSample.createDiv();
				wrap.style.cssText = 'padding: 0.5em 0;';
				const hr1 = wrap.createEl('hr');
				hr1.style.cssText = 'margin: 0.5em 0; border: none; border-top: 1px solid var(--background-modifier-border);';
				wrap.appendText(sampleText);
				const hr2 = wrap.createEl('hr');
				hr2.style.cssText = 'margin: 0.5em 0; border: none; border-top: 1px solid var(--background-modifier-border);';
				break;
			}
			case 'code': {
				const pre = previewSample.createEl('pre');
				pre.style.cssText = 'background: var(--code-background); padding: 1em; margin: 0.5em 0; border-radius: 4px; font-family: var(--font-monospace);';
				pre.createEl('code', { text: sampleText });
				break;
			}
			default: {
				const bq = previewSample.createEl('blockquote');
				bq.style.cssText = 'border-left: 2px solid var(--interactive-accent); padding-left: 1em; margin: 0.5em 0;';
				bq.appendText(sampleText);
			}
		}
	}
}
