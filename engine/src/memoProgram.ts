import { PublicKey } from "@solana/web3.js";

/** SPL Memo v2 (same id on every cluster; the local validator ships it too). Every account passed to it must sign. */
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
