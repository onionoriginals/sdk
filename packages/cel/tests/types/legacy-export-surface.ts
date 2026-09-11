// Compile-time regression (issue #597): every layer-manager class *and* its
// config/data types must be reachable only from '@originals/cel/legacy', not
// from the package root. Compiled independently of the package tsconfig,
// against the installed export map — see package.json's `typecheck:public`.
import {
  PeerCelManager,
  WebVHCelManager,
  BtcoCelManager,
  type PeerCelConfig,
  type CelAssetData,
  type PeerAssetData,
  type WebVHCelConfig,
  type WebVHMigrationData,
  type BtcoCelConfig,
  type BtcoMigrationData,
} from "@originals/cel/legacy";

declare const peerConfig: PeerCelConfig;
declare const celAssetData: CelAssetData;
declare const peerAssetData: PeerAssetData;
declare const webvhConfig: WebVHCelConfig;
declare const webvhMigrationData: WebVHMigrationData;
declare const btcoConfig: BtcoCelConfig;
declare const btcoMigrationData: BtcoMigrationData;
void peerConfig;
void celAssetData;
void peerAssetData;
void webvhConfig;
void webvhMigrationData;
void btcoConfig;
void btcoMigrationData;
void PeerCelManager;
void WebVHCelManager;
void BtcoCelManager;

// @ts-expect-error PeerCelManager must not be reachable from the package root.
import { PeerCelManager as _RootPeerCelManager } from "@originals/cel";
// @ts-expect-error WebVHCelManager must not be reachable from the package root.
import { WebVHCelManager as _RootWebVHCelManager } from "@originals/cel";
// @ts-expect-error BtcoCelManager must not be reachable from the package root.
import { BtcoCelManager as _RootBtcoCelManager } from "@originals/cel";
// @ts-expect-error PeerCelConfig must not be reachable from the package root.
import type { PeerCelConfig as _RootPeerCelConfig } from "@originals/cel";
// @ts-expect-error CelAssetData must not be reachable from the package root.
import type { CelAssetData as _RootCelAssetData } from "@originals/cel";
// @ts-expect-error PeerAssetData must not be reachable from the package root.
import type { PeerAssetData as _RootPeerAssetData } from "@originals/cel";
// @ts-expect-error WebVHCelConfig must not be reachable from the package root.
import type { WebVHCelConfig as _RootWebVHCelConfig } from "@originals/cel";
// @ts-expect-error WebVHMigrationData must not be reachable from the package root.
import type { WebVHMigrationData as _RootWebVHMigrationData } from "@originals/cel";
// @ts-expect-error BtcoCelConfig must not be reachable from the package root.
import type { BtcoCelConfig as _RootBtcoCelConfig } from "@originals/cel";
// @ts-expect-error BtcoMigrationData must not be reachable from the package root.
import type { BtcoMigrationData as _RootBtcoMigrationData } from "@originals/cel";
