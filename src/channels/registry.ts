// Channel registry — self-registering channel plugins

import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  GroupConfig,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onGroupMigrated: (oldJid: string, newJid: string) => void;
  registeredGroups: () => Record<string, GroupConfig>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
