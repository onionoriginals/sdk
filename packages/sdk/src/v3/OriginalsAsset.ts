import type { AssetResolver } from "./resolution.js";
import { summarizeVerification } from "./verification.js";
import { base64 } from "@scure/base";
import {
  copyValue,
  createNonce,
  validateDocument,
  validateEvent,
  verifyHistory,
  signEvent,
  CelError,
  type CelDocument,
  type DeepReadonly,
  type AssetState,
  type Operation,
} from "@originals/cel/v3";
import type {
  AssetEnvelope,
  AssetResource,
  AssetUpdate,
  AssetVerification,
  LocalResource,
  LocalResourceAttachment,
  MutationOptions,
  MutationResult,
  OriginalsConfig,
  ResourceAttachment,
} from "./types.js";
import { attachment, bindResources, bytes } from "./resources.js";
import {
  copyAttachments,
  copyLocalResources,
  checkAttachmentBudget,
  record,
  AttachmentBudget,
} from "./envelope.js";
import { mutationOptions } from "./options.js";

/** A local CEL 3 asset. State comes only from the shared controller-history verifier. */
export class OriginalsAsset {
  #document: CelDocument;
  #attachments: ResourceAttachment[];
  #config: OriginalsConfig;
  #localResources: LocalResourceAttachment[];
  #queue: Promise<void> = Promise.resolve();

  /** @internal All inputs are revalidated; no caller-supplied state or verification token is trusted. */
  constructor(
    document: unknown,
    attachments: ResourceAttachment[],
    config: OriginalsConfig = {},
    expectedDid?: string,
    localResources: LocalResourceAttachment[] = [],
    private readonly resolver?: AssetResolver,
  ) {
    this.#document = validateDocument(document);
    verifyHistory(this.#document, { expectedDid });
    const budget = new AttachmentBudget();
    this.#attachments = copyAttachments(attachments, budget);
    bindResources(this.#document, this.#attachments);
    this.#config = mutationOptions(config);
    this.#localResources = copyLocalResources(localResources, budget);
    checkAttachmentBudget([...this.#attachments, ...this.#localResources]);
  }

  /** The immutable current state derived by the core, including its current controller. */
  get state(): DeepReadonly<AssetState> {
    return verifyHistory(this.#document).state;
  }
  /** Stable genesis identity, independent of later aliases or proofs. */
  get id(): string {
    return this.state.didCel;
  }
  /** Detached log copy; mutating it cannot replace this instance's accepted history. */
  get celLog(): CelDocument {
    return validateDocument(this.#document);
  }
  /** All authenticated versions; returned buffers are detached from internal byte storage. */
  get resources(): AssetResource[] {
    return bindResources(this.#document, this.#attachments);
  }
  /** Detached local editing material. These bytes have no authenticated version or creator claim. */
  get localResources(): LocalResource[] {
    return this.#localResources.map((r) => ({
      ...r,
      content: base64.decode(r.content.data),
    }));
  }

  // One non-reentrant queue encloses every state read, custody lookup, sign and commit.
  // Rejected turns release the queue; observers see the previous committed snapshot until commit.
  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async #append(
    operation: Exclude<Operation, { type: "create" }>,
    options: MutationOptions,
    added: ResourceAttachment[] = [],
    retireLocalResource?: string,
  ): Promise<MutationResult> {
    const state = this.state;
    if (!state.active)
      throw new CelError(
        "invalid",
        "CEL_DEACTIVATED",
        "Deactivated history is terminal",
      );
    if (
      operation.type === "rotateKey" &&
      operation.data.newController === state.controller
    )
      throw new CelError(
        "invalid",
        "CEL_ROTATION",
        "Rotation must change the controller",
      );
    const event = validateEvent({ operation, previousEvent: state.head });
    checkAttachmentBudget([
      ...this.#attachments,
      ...added,
      ...this.#localResources.filter(
        (r) => r.localResourceId !== retireLocalResource,
      ),
    ]);
    const signer = options.signer ?? this.#config.signer;
    if (!signer) {
      if ((options.onAppendFailure ?? this.#config.onAppendFailure) === "skip")
        return { status: "skipped", reason: "NO_SIGNING_KEY" };
      throw new CelError(
        "invalid",
        "NO_SIGNING_KEY",
        "Supply the current controller signer for this append",
      );
    }
    if (signer.controller !== state.controller)
      throw new CelError(
        "invalid",
        "CEL_AUTHORITY",
        "Only the current controller may append",
      );
    const entry = await signEvent(event, signer);
    const document = validateDocument({ log: [...this.#document.log, entry] });
    const history = verifyHistory(document, { expectedDid: this.id });
    const attachments = [...this.#attachments, ...added];
    bindResources(document, attachments);
    // No await between the two assignments: the log and byte attachments commit together.
    this.#document = document;
    this.#attachments = attachments;
    if (retireLocalResource)
      this.#localResources = this.#localResources.filter(
        (r) => r.localResourceId !== retireLocalResource,
      );
    return { status: "signed", head: history.state.head };
  }

  /** Append a controller-authorized replacement of name and/or metadata, serialized with all other edits. */
  async update(
    input: AssetUpdate,
    options: MutationOptions = {},
  ): Promise<MutationResult> {
    const data = copyValue(record(input)) as unknown as AssetUpdate;
    if (Object.keys(data).some((key) => key !== "name" && key !== "metadata"))
      throw new CelError(
        "invalid",
        "ASSET_UPDATE",
        "Update accepts only name and metadata; edit bytes with addResourceVersion",
      );
    const custody = mutationOptions(options);
    return this.#exclusive(() =>
      this.#append(
        { type: "update", data: { ...data, profile: "originals/cel/3" } },
        custody,
      ),
    );
  }

  /** Replace an existing resource's bytes. Version and predecessor come from the queued verified state. */
  async addResourceVersion(
    id: string,
    input: Uint8Array | string,
    mediaType: string,
    options: MutationOptions = {},
  ): Promise<MutationResult> {
    const content = bytes(input),
      custody = mutationOptions(options);
    return this.#exclusive(() =>
      this.#resourceVersion(id, content, mediaType, custody),
    );
  }

  async #resourceVersion(
    id: string,
    content: Uint8Array,
    mediaType: string,
    options: MutationOptions,
    retireLocalResource?: string,
  ): Promise<MutationResult> {
    const current = this.state.resources.find((r) => r.id === id);
    if (!current)
      throw new CelError(
        "invalid",
        "ASSET_RESOURCE_UNKNOWN",
        "Resource id is not part of this Original",
      );
    const blob = attachment(id, current.version + 1, content);
    const result = await this.#append(
      {
        type: "update",
        data: {
          profile: "originals/cel/3",
          resources: [
            {
              id,
              mediaType,
              digestMultibase: blob.digestMultibase,
              previousDigestMultibase: current.digestMultibase,
            },
          ],
        },
      },
      options,
      [blob],
      retireLocalResource,
    );
    if (result.status === "skipped") {
      const localResourceId = retireLocalResource ?? createNonce();
      if (!retireLocalResource) {
        if (
          this.#localResources.some(
            (r) => r.localResourceId === localResourceId,
          )
        )
          throw new CelError(
            "invalid",
            "ASSET_LOCAL_RESOURCE",
            "Local resource id collision; retry the edit",
          );
        const local = copyLocalResources([
          {
            localResourceId,
            id,
            mediaType,
            baseDigestMultibase: current.digestMultibase,
            baseVersion: current.version,
            content: blob.content,
          },
        ])[0];
        checkAttachmentBudget([
          ...this.#attachments,
          ...this.#localResources,
          local,
        ]);
        this.#localResources.push(local);
      }
      return { ...result, localResourceId };
    }
    return result;
  }

  /** Retry retained bytes only while their authenticated predecessor is still current. Never silently rebase an edit. */
  async retryResourceVersion(
    localResourceId: string,
    options: MutationOptions = {},
  ): Promise<MutationResult> {
    const custody = mutationOptions(options);
    return this.#exclusive(() => {
      const local = this.#localResources.find(
        (r) => r.localResourceId === localResourceId,
      );
      if (!local)
        throw new CelError(
          "invalid",
          "ASSET_LOCAL_RESOURCE_UNKNOWN",
          "No retained resource with that id",
        );
      const current = this.state.resources.find((r) => r.id === local.id);
      if (
        current?.digestMultibase !== local.baseDigestMultibase ||
        current?.version !== local.baseVersion
      )
        throw new CelError(
          "invalid",
          "ASSET_LOCAL_RESOURCE_STALE",
          "Retained bytes were edited against a different resource predecessor",
        );
      return this.#resourceVersion(
        local.id,
        base64.decode(local.content.data),
        local.mediaType,
        custody,
        localResourceId,
      );
    });
  }

  /** Explicitly discard one unsigned local edit, serialized with signing/retry operations. */
  async discardLocalResource(localResourceId: string): Promise<void> {
    return this.#exclusive(() => {
      if (
        !this.#localResources.some((r) => r.localResourceId === localResourceId)
      )
        throw new CelError(
          "invalid",
          "ASSET_LOCAL_RESOURCE_UNKNOWN",
          "No retained resource with that id",
        );
      this.#localResources = this.#localResources.filter(
        (r) => r.localResourceId !== localResourceId,
      );
      return Promise.resolve();
    });
  }

  /** The outgoing current controller signs its replacement; retired keys have no continuing authority. */
  async rotateKey(
    newController: string,
    options: MutationOptions = {},
  ): Promise<MutationResult> {
    const custody = mutationOptions(options);
    return this.#exclusive(() =>
      this.#append(
        {
          type: "rotateKey",
          data: {
            profile: "originals/cel/3",
            newController,
            rotatedAt: new Date().toISOString(),
          },
        },
        custody,
      ),
    );
  }

  /** Append terminal controller-authorized deactivation; the authenticated historical record remains readable. */
  async deactivate(
    reason?: string,
    options: MutationOptions = {},
  ): Promise<MutationResult> {
    const custody = mutationOptions(options);
    return this.#exclusive(() =>
      this.#append(
        {
          type: "deactivate",
          data: {
            profile: "originals/cel/3",
            deactivatedAt: new Date().toISOString(),
            ...(reason !== undefined ? { reason } : {}),
          },
        },
        custody,
      ),
    );
  }

  /** Inspect local history and bytes. Publication and ownership require their separate adapters. */
  async verification(): Promise<AssetVerification> {
    const state = this.state;
    const publication =
      state.layer === "btco" && this.resolver
        ? await this.resolver.check(state.alias, state.didCel)
        : undefined;
    return summarizeVerification(this, publication);
  }

  /** True only for fully checked local history and resource bytes; never asserts Bitcoin acceptance. */
  async verify(): Promise<boolean> {
    return (await this.verification()).verified;
  }

  /** Synchronous snapshot of the last committed state, with explicit base64 byte attachments. */
  serialize(): AssetEnvelope {
    return {
      format: "originals/asset",
      version: 3,
      assetDid: this.id,
      eventLog: this.celLog,
      resources: copyAttachments(this.#attachments),
      ...(this.#localResources.length
        ? {
            unverified: {
              localResources: copyLocalResources(this.#localResources),
            },
          }
        : {}),
    };
  }
}
