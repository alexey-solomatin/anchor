import { GetProgramAccountsFilter } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { Layout } from "buffer-layout";
import camelcase from "camelcase";
import { sha256 } from "js-sha256";
import { Idl, IdlTypeDef } from "../../idl.js";
import { IdlCoder } from "./idl.js";
import { AccountsCoder } from "../index.js";
import { accountSize } from "../common.js";

/**
 * Number of bytes of the account header.
 */
const ACCOUNT_HEADER_SIZE = 8;

/**
 * Number of bytes of the account discriminator.
 */
const ACCOUNT_DISCRIMINATOR_SIZE = 4;
const DEPRECATED_ACCOUNT_DISCRIMINATOR_SIZE = 8;

/**
 * Encodes and decodes account objects.
 */
export class BorshAccountsCoder<A extends string = string>
  implements AccountsCoder {
  /**
   * Maps account type identifier to a layout.
   */
  private accountLayouts: Map<A, Layout>;

  /**
   * IDL whose acconts will be coded.
   */
  private idl: Idl;

  /**
   * Header configuration.
   */
  private header: BorshAccountHeader;

  public constructor(idl: Idl) {
    if (idl.accounts === undefined) {
      this.accountLayouts = new Map();
      return;
    }
    const layouts: [A, Layout][] = idl.accounts.map((acc) => {
      return [acc.name as A, IdlCoder.typeDefLayout(acc, idl.types)];
    });

    this.accountLayouts = new Map(layouts);
    this.idl = idl;
    this.header = new BorshAccountHeader(idl);
  }

  public async encode<T = any>(accountName: A, account: T): Promise<Buffer> {
    const buffer = Buffer.alloc(1000); // TODO: use a tighter buffer.
    const layout = this.accountLayouts.get(accountName);
    if (!layout) {
      throw new Error(`Unknown account: ${accountName}`);
    }
    const len = layout.encode(account, buffer);
    let accountData = buffer.slice(0, len);
    let header = this.header.encode(accountName);
    return Buffer.concat([header, accountData]);
  }

  public decode<T = any>(accountName: A, data: Buffer): T {
    const expectedDiscriminator = this.header.discriminator(accountName);
    const givenDisc = this.header.parseDiscriminator(data);
    if (expectedDiscriminator.compare(givenDisc)) {
      throw new Error("Invalid account discriminator");
    }
    return this.decodeUnchecked(accountName, data);
  }

  public decodeUnchecked<T = any>(accountName: A, ix: Buffer): T {
    const data = ix.slice(BorshAccountHeader.size()); // Chop off the header.
    const layout = this.accountLayouts.get(accountName);
    if (!layout) {
      throw new Error(`Unknown account: ${accountName}`);
    }
    return layout.decode(data);
  }

  public memcmp(accountName: A): GetProgramAccountsFilter {
    const discriminator = this.header.discriminator(accountName);
    return {
      memcmp: {
        offset: this.header.discriminatorOffset(),
        bytes: bs58.encode(discriminator),
      },
    };
  }

  public memcmpDataOffset(): number {
    return BorshAccountHeader.size();
  }

  public size(idlAccount: IdlTypeDef): number {
    return BorshAccountHeader.size() + (accountSize(this.idl, idlAccount) ?? 0);
  }
}

export class BorshAccountHeader {
  constructor(private _idl: Idl) {}

  /**
   * Returns the default account header for an account with the given name.
   */
  public encode(accountName: string, nameSpace?: string): Buffer {
    if (this._idl.layoutVersion === undefined) {
      return this.discriminator(accountName, nameSpace);
    } else {
      return Buffer.concat([
        Buffer.from([0]), // Version.
        Buffer.from([0]), // Bump.
        this.discriminator(accountName, nameSpace), // Disc.
        Buffer.from([0, 0]), // Unused.
      ]);
    }
  }

  /**
   * Calculates and returns a unique 8 byte discriminator prepended to all anchor accounts.
   *
   * @param name The name of the account to calculate the discriminator.
   */
  public discriminator(name: string, nameSpace?: string): Buffer {
    return Buffer.from(
      sha256.digest(
        `${nameSpace ?? "account"}:${camelcase(name, { pascalCase: true })}`
      )
    ).slice(0, this.discriminatorSize());
  }

  public discriminatorSize(): number {
    return this._idl.layoutVersion === undefined
      ? DEPRECATED_ACCOUNT_DISCRIMINATOR_SIZE
      : ACCOUNT_DISCRIMINATOR_SIZE;
  }

  /**
   * Returns the account data index at which the discriminator starts.
   */
  public discriminatorOffset(): number {
    if (this._idl.layoutVersion === undefined) {
      return 0;
    } else {
      return 2;
    }
  }

  /**
   * Returns the byte size of the account header.
   */
  public static size(): number {
    return ACCOUNT_HEADER_SIZE;
  }

  /**
   * Returns the discriminator from the given account data.
   */
  public parseDiscriminator(data: Buffer): Buffer {
    if (this._idl.layoutVersion === undefined) {
      return data.slice(0, 8);
    } else {
      return data.slice(2, 6);
    }
  }
}
