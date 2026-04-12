import streamDeck, {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { CodexAppServerClient } from "./lib/codex-app-server";
import { renderBlankImage, renderErrorImage, renderUsageImage } from "./lib/render";

const ACTION_UUID = "dev.akira.codex-limit-tracker.usage";
const DEFAULT_REFRESH_SECONDS = 60;
type WindowMode = "5h" | "7d";

type UsageSettings = JsonObject & {
  refreshSeconds?: number;
  windowMode?: WindowMode;
};

type VisibleAction = {
  action: WillAppearEvent<UsageSettings>["action"];
  settings: UsageSettings;
  timer?: NodeJS.Timeout;
  refreshInFlight?: Promise<void>;
};

@action({ UUID: ACTION_UUID })
export class CodexUsageAction extends SingletonAction<UsageSettings> {
  private readonly client = new CodexAppServerClient();
  private readonly visibleActions = new Map<string, VisibleAction>();

  override async onWillAppear(ev: WillAppearEvent<UsageSettings>): Promise<void> {
    const settings = this.normalizeSettings(ev.payload.settings);
    await ev.action.setSettings(settings);

    const visibleAction: VisibleAction = {
      action: ev.action,
      settings,
    };

    this.visibleActions.set(this.getContextId(ev), visibleAction);
    await ev.action.setTitle("");

    const cachedSnapshot = this.client.getCachedSnapshot();
    if (cachedSnapshot) {
      await this.renderSnapshot(entryFromMap(this.visibleActions, this.getContextId(ev)), cachedSnapshot);
    } else {
      await ev.action.setImage(renderBlankImage());
    }

    this.startPolling(this.getContextId(ev));
  }

  override onWillDisappear(ev: WillDisappearEvent<UsageSettings>): void {
    this.stopPolling(this.getContextId(ev));
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<UsageSettings>,
  ): Promise<void> {
    const contextId = this.getContextId(ev);
    const entry = this.visibleActions.get(contextId);
    if (!entry) {
      return;
    }

    entry.settings = this.normalizeSettings(ev.payload.settings);
    const cachedSnapshot = this.client.getCachedSnapshot();
    if (cachedSnapshot) {
      await this.renderSnapshot(entry, cachedSnapshot);
    }
    this.startPolling(contextId);
  }

  override async onKeyDown(ev: KeyDownEvent<UsageSettings>): Promise<void> {
    const contextId = this.getContextId(ev);
    const entry = this.visibleActions.get(contextId);
    if (!entry) {
      return;
    }

    entry.settings.windowMode = entry.settings.windowMode === "7d" ? "5h" : "7d";
    await ev.action.setSettings(entry.settings);

    const cachedSnapshot = this.client.getCachedSnapshot();
    if (cachedSnapshot) {
      await this.renderSnapshot(entry, cachedSnapshot);
      return;
    }

    await this.refresh(entry);
  }

  private getContextId(
    ev:
      | WillAppearEvent<UsageSettings>
      | WillDisappearEvent<UsageSettings>
      | DidReceiveSettingsEvent<UsageSettings>
      | KeyDownEvent<UsageSettings>,
  ): string {
    return ev.action.id;
  }

  private normalizeSettings(settings: UsageSettings | undefined): UsageSettings {
    const refreshSeconds =
      typeof settings?.refreshSeconds === "number" && settings.refreshSeconds >= 15
        ? Math.round(settings.refreshSeconds)
        : DEFAULT_REFRESH_SECONDS;

    const windowMode: WindowMode = settings?.windowMode === "5h" ? "5h" : "7d";

    return {
      ...settings,
      refreshSeconds,
      windowMode,
    };
  }

  private startPolling(contextId: string): void {
    const entry = this.visibleActions.get(contextId);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      clearInterval(entry.timer);
    }

    void this.refresh(entry);
    entry.timer = setInterval(() => {
      void this.refresh(entry);
    }, (entry.settings.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) * 1000);
  }

  private stopPolling(contextId: string): void {
    const entry = this.visibleActions.get(contextId);
    if (!entry) {
      return;
    }

    if (entry.timer) {
      clearInterval(entry.timer);
    }

    this.visibleActions.delete(contextId);
  }

  private async refresh(entry: VisibleAction): Promise<void> {
    if (entry.refreshInFlight) {
      return entry.refreshInFlight;
    }

    entry.refreshInFlight = this.performRefresh(entry).finally(() => {
      entry.refreshInFlight = undefined;
    });

    return entry.refreshInFlight;
  }

  private async performRefresh(entry: VisibleAction): Promise<void> {
    try {
      const snapshot = await this.client.readDisplaySnapshot();
      await this.renderSnapshot(entry, snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      streamDeck.logger.error("Codex usage refresh failed", { message });

      const cachedSnapshot = this.client.getCachedSnapshot();
      if (cachedSnapshot) {
        await this.renderSnapshot(entry, cachedSnapshot);
        return;
      }

      await entry.action.setTitle("");
      await entry.action.setImage(renderErrorImage("Error", this.toShortMessage(message)));
    }
  }

  private async renderSnapshot(entry: VisibleAction, snapshot: Parameters<typeof renderUsageImage>[0]): Promise<void> {
    await entry.action.setTitle("");
    await entry.action.setImage(renderUsageImage(snapshot, entry.settings.windowMode ?? "7d"));
  }

  private toShortMessage(message: string): string {
    if (/not logged in|auth/i.test(message)) {
      return "Login";
    }

    if (/not found|install/i.test(message)) {
      return "Install";
    }

    return "Retry";
  }
}

function entryFromMap(
  map: Map<string, VisibleAction>,
  contextId: string,
): VisibleAction {
  const entry = map.get(contextId);
  if (!entry) {
    throw new Error(`Missing action context: ${contextId}`);
  }

  return entry;
}
