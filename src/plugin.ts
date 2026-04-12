import streamDeck from "@elgato/streamdeck";

import { CodexUsageAction } from "./usage-action";

streamDeck.actions.registerAction(new CodexUsageAction());
streamDeck.connect();
