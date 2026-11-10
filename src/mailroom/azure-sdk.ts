import type * as Identity from "@azure/identity"
import type * as StorageBlob from "@azure/storage-blob"
import { emitNervesEvent } from "../nerves/runtime"

export interface AzureBlobSdk {
  BlobServiceClient: typeof StorageBlob.BlobServiceClient
  DefaultAzureCredential: typeof Identity.DefaultAzureCredential
}

let loaded: AzureBlobSdk | null = null

/**
 * The Azure storage and identity SDKs, loaded on first use.
 *
 * They cost about 22 MB and 200 modules in every process that imports them, and
 * only a hosted mailroom needs them, so callers reach them through this
 * function instead of a top-level import.
 */
export function loadAzureBlobSdk(): AzureBlobSdk {
  if (loaded) return loaded
  const { BlobServiceClient } = require("@azure/storage-blob") as typeof StorageBlob
  const { DefaultAzureCredential } = require("@azure/identity") as typeof Identity
  loaded = { BlobServiceClient, DefaultAzureCredential }
  emitNervesEvent({
    level: "debug",
    component: "senses",
    event: "senses.mail_azure_sdk_loaded",
    message: "loaded the Azure storage and identity SDKs for hosted mail",
    meta: {},
  })
  return loaded
}
