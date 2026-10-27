export default 'UserAsSystem'; // Init ES module

const context = SillyTavern.getContext();
const settingsKey = 'userAsSystem';

const TARGET_ROLES = Object.freeze({
    OFF: 'user',
    ASSISTANT: 'assistant',
    SYSTEM: 'system',
});

/**
 * @type {UserAsSystemSettings}
 * @typedef {Object} UserAsSystemSettings
 * @property {boolean} enabled - Whether the experiment is enabled.
 * @property {string} targetRole - Role to convert user messages to: "assistant" | "system" | "user" (off).
 * @property {string} assistantTargetRole - Role to convert assistant (AI) messages to: "assistant" (off) | "user" | "system".
 * @property {boolean} keepLastUser - Leave the newest user message unconverted.
 */
const defaultSettings = Object.freeze({
    enabled: true,
    targetRole: TARGET_ROLES.SYSTEM,
    assistantTargetRole: TARGET_ROLES.ASSISTANT,
    keepLastUser: false,
});

/**
 * Signature of the newest chat-history user message left unconverted when
 * keepLastUser is enabled. Used to avoid converting it again in the final
 * payload while still converting the Prompt Manager's user-role prompts.
 * @type {{ content: string, name: string | null } | null}
 */
let preservedUserMessage = null;

/** @type {string | null} */
let currentGenerationType = null;
let listenersRegistered = false;

function getSettings() {
    const store = context.extensionSettings ?? (context.extensionSettings = {});

    if (!store[settingsKey] || typeof store[settingsKey] !== 'object') {
        store[settingsKey] = structuredClone(defaultSettings);
    } else {
        for (const [key, value] of Object.entries(defaultSettings)) {
            if (store[settingsKey][key] === undefined) {
                store[settingsKey][key] = value;
            }
        }
    }

    return /** @type {UserAsSystemSettings} */ (store[settingsKey]);
}

/**
 * @param {UserAsSystemSettings} settings
 * @returns {'assistant' | 'system' | null}
 */
function getTargetRole(settings) {
    const targetRole = settings?.targetRole;

    if (targetRole === TARGET_ROLES.ASSISTANT || targetRole === TARGET_ROLES.SYSTEM) {
        return targetRole;
    }

    return null;
}

/**
 * @param {object} row
 * @returns {boolean}
 */
function isUserRow(row) {
    return !!row && typeof row === 'object' && (row.is_user === true || row.role === 'user');
}

/**
 * @param {object} row
 * @returns {boolean}
 */
function isAssistantRow(row) {
    if (!row || typeof row !== 'object' || isUserRow(row)) {
        return false;
    }

    // Never touch system-role, tool, or hidden "small system" notes.
    if (row.is_system === true || row.role === 'tool' || row.role === 'system') {
        return false;
    }

    if (row.extra?.isSmallSys === true) {
        return false;
    }

    return row.role === 'assistant' || row.role === undefined || row.role === null;
}

/**
 * Assistant conversion target: null means "leave assistant messages alone".
 * @param {UserAsSystemSettings} settings
 * @returns {'assistant' | 'user' | 'system' | null}
 */
function getAssistantTargetRole(settings) {
    const targetRole = settings?.assistantTargetRole;

    if (targetRole === TARGET_ROLES.USER || targetRole === TARGET_ROLES.SYSTEM) {
        return targetRole;
    }

    return null;
}

/**
 * @param {UserAsSystemSettings} settings
 * @param {boolean | undefined} dryRun
 * @param {string | null | undefined} type
 * @returns {boolean}
 */
function shouldSkip(settings, dryRun, type) {
    if (settings?.enabled !== true || dryRun === true) {
        return true;
    }

    if (type === 'quiet' || type === 'impersonate') {
        return true;
    }

    // Skip only when BOTH directions are off.
    return getTargetRole(settings) === null && getAssistantTargetRole(settings) === null;
}

/**
 * Remember which chat-history message must stay unconverted.
 * @param {object} row
 */
function rememberPreservedUser(row) {
    const content = typeof row.mes === 'string'
        ? row.mes
        : typeof row.content === 'string'
            ? row.content
            : '';

    preservedUserMessage = {
        content,
        name: typeof row.name === 'string' ? row.name : null,
    };
}

/**
 * Convert a raw chat row (chat history format) so setOpenAIMessages derives
 * the requested role for it. The live chat object is never mutated.
 * @param {object} row
 * @param {'assistant' | 'system'} targetRole
 * @returns {object}
 */
function convertCoreRow(row, targetRole) {
    /** @type {Record<string, any>} */
    const converted = { ...row, is_user: false };

    if (row.role === 'user') {
        converted.role = targetRole;
    }

    if (targetRole === TARGET_ROLES.SYSTEM) {
        converted.extra = { ...(row.extra ?? {}), type: 'narrator' };
    }

    return converted;
}

/**
 * Convert a raw chat row that represents an assistant message.
 * The live chat object is never mutated.
 * @param {object} row
 * @param {'user' | 'system'} targetRole
 * @returns {object}
 */
function convertAssistantCoreRow(row, targetRole) {
    /** @type {Record<string, any>} */
    const converted = { ...row };
    /** @type {Record<string, any>} */
    const extra = { ...(row.extra ?? {}) };

    if (targetRole === TARGET_ROLES.USER) {
        converted.is_user = true;
        converted.is_system = false;
        // A narrator marker would keep forcing role "system" — strip it.
        if (extra.type === 'narrator') {
            delete extra.type;
        }
        converted.extra = extra;
        return converted;
    }

    converted.is_user = false;
    extra.type = 'narrator';
    converted.extra = extra;
    return converted;
}

/**
 * Rewrites the role of user messages in the outgoing prompt.
 *
 * This interceptor handles chat-history rows before prompt assembly. Final
 * payloads (including Prompt Manager prompts such as the Main Prompt) are
 * handled by the CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_DATA hooks
 * below, because those messages do not exist yet when this interceptor runs.
 *
 * @param {object[]} chat Chat prompt entries prepared for generation
 * @param {number} _contextSize Context size (not used)
 * @param {function} _abort Abort function (not used)
 * @param {string} type Generation type
 */
globalThis.UserAsSystem_interceptGeneration = function (chat, _contextSize, _abort, type) {
    currentGenerationType = type ?? currentGenerationType;
    preservedUserMessage = null;

    const settings = getSettings();
    if (!Array.isArray(chat) || shouldSkip(settings, false, type)) {
        return;
    }

    const userTarget = getTargetRole(settings);
    const assistantTarget = getAssistantTargetRole(settings);

    // Index of the newest user row in this prompt.
    let lastUserIndex = -1;
    for (let i = 0; i < chat.length; i++) {
        if (isUserRow(chat[i])) {
            lastUserIndex = i;
        }
    }

    let convertedUser = 0;
    let convertedAssistant = 0;
    for (let i = 0; i < chat.length; i++) {
        const row = chat[i];

        // Classify by the ORIGINAL row so the two directions can never
        // re-process each other's output in the same pass.
        if (isUserRow(row)) {
            if (!userTarget) {
                continue;
            }
            if (settings.keepLastUser === true && i === lastUserIndex) {
                rememberPreservedUser(row);
                continue;
            }

            chat[i] = convertCoreRow(row, userTarget);
            convertedUser++;
        } else if (isAssistantRow(row) && assistantTarget) {
            chat[i] = convertAssistantCoreRow(row, assistantTarget);
            convertedAssistant++;
        }
    }

    console.log(`[UserAsSystem] interceptor type=${type ?? 'normal'} user->${userTarget ?? 'off'} assistant->${assistantTarget ?? 'off'} converted ${convertedUser} user / ${convertedAssistant} assistant message(s)`);
};

/**
 * @param {any[]} chat
 * @returns {number} Index of the preserved history message, or -1.
 */
function findPreservedUserIndex(chat) {
    const preserved = preservedUserMessage;
    if (!preserved) {
        return -1;
    }

    const normalize = (value) => String(value ?? '').replace(/\r/gm, '');
    const rawContent = normalize(preserved.content);
    let looseMatch = -1;

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || typeof message !== 'object' || String(message.role ?? '').toLowerCase() !== 'user') {
            continue;
        }

        const content = normalize(message.content);

        // Names behavior may prefix the content with "Name: ". Match the raw
        // history text as a suffix so the preserved row is recognized.
        if (rawContent) {
            if (content === rawContent || content.endsWith(rawContent)) {
                return i;
            }
            if (looseMatch === -1 && content.includes(rawContent)) {
                looseMatch = i;
            }
        } else if (preserved.name && message.name === preserved.name) {
            return i;
        }
    }

    return looseMatch;
}

/**
 * Convert every remaining user-role message in the final outgoing payload.
 * This is the authoritative pass: it also covers Prompt Manager prompts that
 * are added after the generation interceptor has run.
 *
 * @param {any[]} chat Final chat-completion messages.
 * @param {boolean | undefined} dryRun
 * @param {string | null | undefined} type
 * @param {string} source Log label.
 * @returns {number} Number of converted messages.
 */
function convertFinalChat(chat, dryRun, type, source) {
    const settings = getSettings();
    if (!Array.isArray(chat) || shouldSkip(settings, dryRun, type)) {
        return 0;
    }

    const userTarget = getTargetRole(settings);
    const assistantTarget = getAssistantTargetRole(settings);
    if (!userTarget && !assistantTarget) {
        return 0;
    }

    let keepIndex = -1;
    if (userTarget && settings.keepLastUser === true) {
        keepIndex = findPreservedUserIndex(chat);

        // Fallback when the interceptor did not record a message (for example
        // an alternate generation path): leave the newest user-role message.
        if (keepIndex === -1) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (String(chat[i]?.role ?? '').toLowerCase() === 'user') {
                    keepIndex = i;
                    break;
                }
            }
        }
    }

    let convertedUser = 0;
    let convertedAssistant = 0;
    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];

        if (!message || typeof message !== 'object') {
            continue;
        }

        const role = String(message.role ?? '').toLowerCase();

        // Classify by the ORIGINAL role so a user->assistant conversion can
        // never be chained into assistant->user in the same pass.
        if (role === 'user') {
            if (!userTarget || i === keepIndex) {
                continue;
            }
            // Replace rather than assign to message.role so event consumers
            // still receive a clean {role, content, name, ...} object.
            chat[i] = { ...message, role: userTarget };
            convertedUser++;
        } else if (role === 'assistant' && assistantTarget) {
            chat[i] = { ...message, role: assistantTarget };
            convertedAssistant++;
        }
    }

    if (convertedUser > 0 || convertedAssistant > 0) {
        console.log(`[UserAsSystem] ${source} type=${type ?? 'normal'} user->${userTarget ?? 'off'} assistant->${assistantTarget ?? 'off'} converted ${convertedUser} user / ${convertedAssistant} assistant message(s)`);
    }

    return convertedUser + convertedAssistant;
}

/**
 * @param {{ chat?: any[], dryRun?: boolean } | any[]} eventData
 * @param {boolean} [dryRunArg]
 */
function onChatCompletionPromptReady(eventData, dryRunArg) {
    const isObject = !!eventData && !Array.isArray(eventData) && typeof eventData === 'object';
    const chat = Array.isArray(eventData) ? eventData : isObject ? eventData.chat : null;
    const dryRun = isObject ? eventData.dryRun : dryRunArg;

    convertFinalChat(chat, dryRun, currentGenerationType, 'prompt-ready');
}

/**
 * @param {{ prompt?: any[] } | any[]} generateData
 * @param {boolean} [dryRun]
 */
function onGenerateAfterData(generateData, dryRun) {
    const prompt = Array.isArray(generateData)
        ? generateData
        : Array.isArray(generateData?.prompt)
            ? generateData.prompt
            : null;

    convertFinalChat(prompt, dryRun, currentGenerationType, 'generate-after-data');
}

/**
 * @param {string} type
 * @param {object} _params
 * @param {boolean} dryRun
 */
function onGenerationStarted(type, _params, dryRun) {
    if (dryRun === true) {
        return;
    }

    currentGenerationType = type ?? null;
    preservedUserMessage = null;
}

function onGenerationEnded() {
    currentGenerationType = null;
    preservedUserMessage = null;
}

function registerEventListeners() {
    if (listenersRegistered) {
        return;
    }

    const eventSource = context.eventSource;
    const events = context.eventTypes;

    if (!eventSource || !events) {
        console.error('[UserAsSystem] event system is unavailable');
        return;
    }

    listenersRegistered = true;

    if (events.GENERATION_STARTED) {
        eventSource.on(events.GENERATION_STARTED, onGenerationStarted);
    }
    if (events.GENERATION_ENDED) {
        eventSource.on(events.GENERATION_ENDED, onGenerationEnded);
    }
    if (events.CHAT_COMPLETION_PROMPT_READY) {
        eventSource.on(events.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
    }
    if (events.GENERATE_AFTER_DATA) {
        eventSource.on(events.GENERATE_AFTER_DATA, onGenerateAfterData);
    }
}

function addSettings() {
    /** @type {UserAsSystemSettings} */
    const settings = getSettings();

    const settingsContainer = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!settingsContainer) {
        return;
    }

    // Don't inject the drawer twice (e.g. APP_READY + late DOM changes).
    if (document.getElementById('uas_drawer')) {
        return;
    }

    const drawer = document.createElement('div');
    drawer.classList.add('inline-drawer');
    drawer.id = 'uas_drawer';

    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');

    const nameEl = document.createElement('b');
    nameEl.textContent = 'User As System (role experiment)';

    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');

    toggle.append(nameEl, icon);

    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');

    // Enabled
    const enabledLabel = document.createElement('label');
    enabledLabel.classList.add('checkbox_label', 'marginBot5');
    enabledLabel.htmlFor = 'uas_enabled';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.id = 'uas_enabled';
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = settings.enabled === true;
    const enabledCheckboxText = document.createElement('span');
    enabledCheckboxText.textContent = 'Enabled';
    enabledLabel.append(enabledCheckbox, enabledCheckboxText);
    content.append(enabledLabel);

    // Target role selector
    const targetLabel = document.createElement('label');
    targetLabel.htmlFor = 'uas_target_role';
    targetLabel.textContent = 'Convert user messages to';
    targetLabel.classList.add('marginBot5');

    const targetSelect = document.createElement('select');
    targetSelect.id = 'uas_target_role';
    targetSelect.classList.add('text_pole');
    const options = [
        { value: TARGET_ROLES.USER, label: 'user (no conversion)' },
        { value: TARGET_ROLES.ASSISTANT, label: 'assistant' },
        { value: TARGET_ROLES.SYSTEM, label: 'system' },
    ];
    for (const option of options) {
        const optionEl = document.createElement('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        optionEl.selected = (option.value === (settings.targetRole ?? TARGET_ROLES.SYSTEM));
        targetSelect.append(optionEl);
    }
    targetSelect.addEventListener('change', () => {
        settings.targetRole = targetSelect.value;
        context.saveSettingsDebounced();
    });
    content.append(targetLabel, targetSelect);

    // Assistant target role selector
    const assistantLabel = document.createElement('label');
    assistantLabel.htmlFor = 'uas_assistant_target_role';
    assistantLabel.textContent = 'Convert assistant (AI) messages to';
    assistantLabel.classList.add('marginBot5');

    const assistantSelect = document.createElement('select');
    assistantSelect.id = 'uas_assistant_target_role';
    assistantSelect.classList.add('text_pole');
    const assistantOptions = [
        { value: TARGET_ROLES.ASSISTANT, label: 'assistant (no conversion)' },
        { value: TARGET_ROLES.USER, label: 'user' },
        { value: TARGET_ROLES.SYSTEM, label: 'system' },
    ];
    for (const option of assistantOptions) {
        const optionEl = document.createElement('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        optionEl.selected = (option.value === (settings.assistantTargetRole ?? TARGET_ROLES.ASSISTANT));
        assistantSelect.append(optionEl);
    }
    assistantSelect.addEventListener('change', () => {
        settings.assistantTargetRole = assistantSelect.value;
        context.saveSettingsDebounced();
    });
    content.append(assistantLabel, assistantSelect);

    // Keep last user message
    const keepLabel = document.createElement('label');
    keepLabel.classList.add('checkbox_label', 'marginBot5');
    keepLabel.htmlFor = 'uas_keep_last';
    const keepCheckbox = document.createElement('input');
    keepCheckbox.id = 'uas_keep_last';
    keepCheckbox.type = 'checkbox';
    keepCheckbox.checked = settings.keepLastUser === true;
    const keepCheckboxText = document.createElement('span');
    keepCheckboxText.textContent = 'Keep the newest user message unchanged';
    keepLabel.append(keepCheckbox, keepCheckboxText);
    content.append(keepLabel);

    const note = document.createElement('div');
    note.classList.add('hint');
    note.textContent = 'Experiment: user and assistant messages, including the Prompt Manager Main Prompt, are sent with the selected roles. Chat history files and the UI are not touched. Check the LLM API log to see the real wire payload.';
    content.append(note);

    drawer.append(toggle, content);
    settingsContainer.append(drawer);

    enabledCheckbox.addEventListener('change', () => {
        settings.enabled = enabledCheckbox.checked;
        context.saveSettingsDebounced();
    });

    keepCheckbox.addEventListener('change', () => {
        settings.keepLastUser = keepCheckbox.checked;
        context.saveSettingsDebounced();
    });
}

function init() {
    getSettings();

    try {
        addSettings();
    } catch (error) {
        console.error('[UserAsSystem] failed to add settings UI', error);
    }

    try {
        registerEventListeners();
    } catch (error) {
        console.error('[UserAsSystem] failed to register event listeners', error);
    }

    try {
        context.eventSource.on(context.eventTypes.APP_READY, () => {
            addSettings();
            registerEventListeners();
        });
    } catch (error) {
        console.error('[UserAsSystem] failed to register APP_READY listener', error);
    }
}

init();
