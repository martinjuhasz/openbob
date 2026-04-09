// openbob Host — Entry Point
// Startup sequence: DB → CredentialProxy → IpcWatcher → TaskScheduler → Channels → Router

import { ASSISTANT_NAME, POLL_INTERVAL, channelFromJid } from './config.js';
import './channels/index.js';
import { loadEnv, getEnv } from './env.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  stopAllContainers,
  stopGroupContainer,
  runAgentSession,
  warmUpContainers,
  startupWarmUp,
  startIdleChecker,
  validateAuthConfig,
} from './container-runner.js';
import {
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getSession,
  initDatabase,
  migrateGroupJid,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { logger } from './logger.js';
import {
  checkTrigger,
  findChannel,
  formatMessages,
  formatOutbound,
} from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, GroupConfig, NewMessage } from './types.js';

let lastTimestamp = '';
let lastAgentTimestamp: Record<string, string> = {};
let registeredGroups: Record<string, GroupConfig> = {};
let messageLoopRunning = false;
const agentFailCount: Record<string, number> = {};
const MAX_RETRIES = 3;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- corrupted state: reset and continue
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

async function handleAgentFailure(
  chatJid: string,
  channel: Channel,
  previousCursor: string,
  errorMessage: string,
): Promise<boolean> {
  agentFailCount[chatJid] = (agentFailCount[chatJid] ?? 0) + 1;
  if (agentFailCount[chatJid] >= MAX_RETRIES) {
    agentFailCount[chatJid] = 0;
    await channel.sendMessage(chatJid, errorMessage).catch(() => {});
    return true;
  }
  lastAgentTimestamp[chatJid] = previousCursor;
  saveState();
  return false;
}

async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) {
    logger.warn(
      { chatJid },
      'processGroupMessages: group not found in registeredGroups',
    );
    return true;
  }

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp);

  logger.debug(
    {
      chatJid,
      folder: group.folder,
      sinceTimestamp,
      missedCount: missedMessages.length,
      alwaysRespond: group.alwaysRespond,
    },
    'processGroupMessages: state',
  );

  if (missedMessages.length === 0) return true;

  // Only respond to all messages if alwaysRespond is set; otherwise require trigger
  if (!group.alwaysRespond) {
    const hasTrigger = checkTrigger(missedMessages, group.trigger);
    if (!hasTrigger) {
      logger.debug(
        { chatJid, trigger: group.trigger },
        'processGroupMessages: no trigger word, skipping',
      );
      return true;
    }
  }

  const prompt = formatMessages(missedMessages);
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  await channel.sendTyping?.(chatJid);

  const model = group.model ?? getEnv().MODEL;
  const sessionId = getSession(group.folder) ?? undefined;

  // Repeat typing indicator every 4s (Telegram expires after ~5s).
  // The AbortController ensures cleanup on every exit path via finally.
  const typingAc = new AbortController();
  const typingInterval = channel.sendTyping
    ? setInterval(() => {
        if (typingAc.signal.aborted) return;
        channel.sendTyping!(chatJid).catch(() => {});
      }, 4_000)
    : undefined;
  typingAc.signal.addEventListener('abort', () =>
    clearInterval(typingInterval),
  );

  try {
    const output = await runAgentSession({
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain: group.isMain,
      model,
    });

    if (output.newSessionId) {
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.warn(
        {
          group: group.name,
          error: output.error,
          failCount: (agentFailCount[chatJid] ?? 0) + 1,
        },
        'Agent error',
      );
      return handleAgentFailure(
        chatJid,
        channel,
        previousCursor,
        `⚠️ Ich konnte nicht antworten (${output.error ?? 'unbekannter Fehler'}). Bitte nochmal versuchen.`,
      );
    }

    agentFailCount[chatJid] = 0;

    if (output.result) {
      const text = formatOutbound(output.result);
      if (text) {
        await channel.sendMessage(chatJid, text);
        logger.info({ group: group.name, chars: text.length }, 'Response sent');
      }
    }

    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- top-level handler: trigger failure recovery
  } catch (err) {
    logger.error(
      { group: group.name, err, failCount: (agentFailCount[chatJid] ?? 0) + 1 },
      'Agent exception',
    );
    return handleAgentFailure(
      chatJid,
      channel,
      previousCursor,
      `⚠️ Interner Fehler. Bitte nochmal versuchen.`,
    );
  } finally {
    typingAc.abort();
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`openbob running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      if (jids.length > 0) {
        const messages = getNewMessages(lastTimestamp);

        if (messages.length > 0) {
          logger.info({ count: messages.length }, 'New messages');

          lastTimestamp = messages[messages.length - 1].timestamp;
          saveState();

          // Group messages by chat JID
          const messagesByGroup = new Map<string, NewMessage[]>();
          for (const msg of messages) {
            if (!jids.includes(msg.chat_jid)) continue;
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) {
              existing.push(msg);
            } else {
              messagesByGroup.set(msg.chat_jid, [msg]);
            }
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = registeredGroups[chatJid];
            if (!group) continue;

            // Only enqueue if alwaysRespond or trigger word present
            if (!group.alwaysRespond) {
              const hasTrigger = checkTrigger(groupMessages, group.trigger);
              if (!hasTrigger) continue;
            }

            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- loop resilience: don't crash poll loop
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function registerInitialGroupFromEnv(): void {
  const jid = process.env['INITIAL_GROUP_JID'];
  if (!jid) return;

  if (registeredGroups[jid]) {
    logger.debug({ jid }, 'Initial group already registered, skipping');
    return;
  }

  const isMain = process.env['INITIAL_GROUP_IS_MAIN'] !== 'false';
  const config: GroupConfig = {
    jid,
    name: 'Main',
    folder: process.env['INITIAL_GROUP_FOLDER'] ?? 'main',
    trigger: process.env['INITIAL_GROUP_TRIGGER'] ?? ASSISTANT_NAME,
    channel: channelFromJid(jid),
    isMain,
    alwaysRespond:
      process.env['INITIAL_GROUP_ALWAYS_RESPOND'] === 'true' || isMain,
    createdAt: Date.now(),
  };
  setRegisteredGroup(config);
  registeredGroups[config.jid] = config;
  logger.info(
    { jid, name: config.name, folder: config.folder },
    'Initial group registered from env',
  );
}

async function main(): Promise<void> {
  loadEnv();
  initDatabase();
  logger.info('Database initialized');
  validateAuthConfig();
  loadState();
  registerInitialGroupFromEnv();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown();
    await stopAllContainers();
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => {
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    onGroupMigrated: (oldJid: string, newJid: string) => {
      const migrated = migrateGroupJid(oldJid, newJid);
      if (!migrated) {
        logger.warn(
          { oldJid, newJid },
          'Group migration: old JID not found in DB, skipping',
        );
        return;
      }
      // Update in-memory map
      const group = registeredGroups[oldJid];
      if (group) {
        delete registeredGroups[oldJid];
        group.jid = newJid;
        registeredGroups[newJid] = group;
      }
      logger.info(
        { oldJid, newJid },
        'Group JID migrated (Telegram supergroup upgrade)',
      );
    },
    registeredGroups: () => registeredGroups,
  };

  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel credentials missing — skipping',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }

  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    queue,
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    getSession,
    setSession,
  });

  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendPhoto: (jid, source, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendPhoto) {
        logger.warn({ jid }, 'Channel does not support sendPhoto');
        return Promise.resolve();
      }
      return channel.sendPhoto(jid, source, caption);
    },
    sendDocument: (jid, source, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendDocument) {
        logger.warn({ jid }, 'Channel does not support sendDocument');
        return Promise.resolve();
      }
      return channel.sendDocument(jid, source, caption);
    },
    registeredGroups: () => registeredGroups,
    onTasksChanged: () => {
      logger.debug('Tasks changed via IPC');
    },
    onGroupRegistered: (config) => {
      registeredGroups[config.jid] = config;
      logger.info(
        { jid: config.jid, name: config.name },
        'Group registered at runtime',
      );
      warmUpContainers([
        { folder: config.folder, model: config.model ?? getEnv().MODEL },
      ]).catch((err) =>
        logger.warn(
          { folder: config.folder, err },
          'Pre-warm failed for new group',
        ),
      );
    },
    onGroupUpdated: (config, oldJid) => {
      if (oldJid) {
        delete registeredGroups[oldJid];
      }
      registeredGroups[config.jid] = config;
      logger.info(
        { jid: config.jid, name: config.name },
        'Group updated at runtime',
      );
    },
    onGroupDeleted: (folder, jid) => {
      delete registeredGroups[jid];
      logger.info({ folder, jid }, 'Group deleted at runtime');
      stopGroupContainer(folder).catch((err) =>
        logger.warn(
          { folder, err },
          'Failed to stop container for deleted group',
        ),
      );
    },
  });

  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Pre-warm agent containers so they're ready on first message
  const env = getEnv();
  const groups = Object.values(registeredGroups).map((g) => ({
    folder: g.folder,
    model: g.model ?? env.MODEL,
  }));
  startupWarmUp(groups).catch((err) => logger.warn({ err }, 'Pre-warm error'));

  // Start idle timeout checker (only active if IDLE_TIMEOUT is set)
  startIdleChecker();

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start openbob');
    process.exit(1);
  });
}
