import { accessSync, constants } from "node:fs";

import { HAPFileStorage } from "./HAPFileStorage";

/**
 * A storage HAP-NodeJS can keep its persistent state in: accessory info including the pairings,
 * identifier caches and controller state. {@link HAPFileStorage} is the default.
 *
 * All three methods are synchronous. {@link setItemSync} and {@link removeItemSync} must only return
 * once the change is persisted: HAP-NodeJS answers the controller right after, so a pairing
 * written to a cache which is lost in a crash leaves an accessory the controller considers paired
 * while it reads as unpaired after the restart.
 *
 * @group Model
 */
export interface HAPStorageBackend {
  /**
   * Returns the value stored for the given key, or `undefined`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getItem(key: string): any;

  /**
   * Persists the given value, which is a JSON serializable object.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setItemSync(key: string, value: any): void;

  /**
   * Removes the value stored for the given key.
   */
  removeItemSync(key: string): void;
}

/**
 * @group Model
 */
export class HAPStorage {

  private static readonly INSTANCE = new HAPStorage();

  private localStore?: HAPStorageBackend;
  private customStoragePath?: string;

  public static storage(): HAPStorageBackend {
    return this.INSTANCE.storage();
  }

  public static setCustomStoragePath(path: string): void {
    this.INSTANCE.setCustomStoragePath(path);
  }

  /**
   * Replaces the file storage with the given one, for example to keep the state in a database
   * the application already persists. Must be called before the first accessory is published.
   */
  public static setCustomStorage(storage: HAPStorageBackend): void {
    this.INSTANCE.setCustomStorage(storage);
  }

  public storage(): HAPStorageBackend {
    if (!this.localStore) {
      const fileStorage = new HAPFileStorage();

      if (this.customStoragePath) {
        fileStorage.initSync({
          dir: this.customStoragePath,
        });
      } else {
        fileStorage.initSync();
      }

      this.localStore = fileStorage;
      this.checkStorageIsWritable();
    }

    return this.localStore;
  }

  /**
   * Warn early if the persist directory cannot be written to.
   *
   * Without this the first sign of trouble is a publish failing with an
   * unrelated-looking error, which is what happens when a container that
   * previously ran as root is switched to a non-root user and the existing
   * AccessoryInfo/IdentifierCache files stay owned by root.
   *
   * Only warns — an unwritable directory is not necessarily fatal at this
   * point, and throwing here would break consumers that never write.
   */
  private checkStorageIsWritable(): void {
    // HAPFileStorage resolves its directory during init and keeps it private;
    // read that rather than recomputing it, falling back to whatever we asked
    // for if the shape ever changes.
    const dir: string | undefined = (this.localStore as unknown as { dir?: string })?.dir
      ?? this.customStoragePath;

    if (!dir) {
      return;
    }

    try {
      accessSync(dir, constants.W_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      // Only a permission problem is worth warning about. A missing directory
      // is not: HAPFileStorage creates it during init, so ENOENT here means we
      // are looking at a path it never used rather than a broken install.
      if (code !== "EACCES" && code !== "EPERM") {
        return;
      }

      console.warn(`HAP-NodeJS WARNING: The persist directory '${dir}' is not writable (${code}). `
        + "Accessories will fail to publish or will lose their pairing state. This usually means the files are "
        + "owned by a different user than the one running HAP-NodeJS — check the ownership and permissions of "
        + "that directory and its contents.");
    }
  }

  public setCustomStoragePath(path: string): void {
    if (this.localStore) {
      throw new Error("Cannot change storage path after it has already been initialized!");
    }

    this.customStoragePath = path;
  }

  public setCustomStorage(storage: HAPStorageBackend): void {
    if (this.localStore) {
      throw new Error("Cannot change storage after it has already been initialized!");
    }

    this.localStore = storage;
  }

}
