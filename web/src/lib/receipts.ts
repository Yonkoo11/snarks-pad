// The three mainnet test receipts, copied from the mainnet receipts. Real Zcash mainnet transactions made with
// small amounts by the pad's owner; none of them is a payout to a coin holder. Anyone can look each one up.
export interface MainnetReceipt {
  id: string
  date: string
  what: string
  zcashTxid: string
  solanaSig?: string
}

export const MAINNET_RECEIPTS: MainnetReceipt[] = [
  {
    id: 'F-030', date: '30 Sep 2026',
    what: 'A real swap through NEAR 1Click: 0.004 Solana ZEC went in, 0.00375 ZEC arrived in the pad\'s Zcash wallet as one shielded (Ironwood) note.',
    zcashTxid: '8007e1086ab46274be507a694ecaef4ddaff8a0e9fe52b930fa88a22ab1478a5',
    solanaSig: '3tSB1Lt6aXZx9MoaPF6AYAnsUd8DNyALZsJGNjSXinwpKkoyEVmKD4vj4LKRgTnekwuiAzJZ23oaUqYU6NW152Zd',
  },
  {
    id: 'P1', date: '1 Oct 2026',
    what: 'That note spent onward in one batched shielded transaction: 0.001 ZEC to the owner\'s Zodl wallet and 0.001 ZEC to a second wallet. Both wallets saw their note.',
    zcashTxid: '63a85230d6cef5a5465b3d9a34327de89f8c63c47a5a6b8e01e31004ca7d961c',
  },
  {
    id: 'P3', date: '1 Oct 2026',
    what: 'The engine\'s own swap code, killed halfway and run again: it found the swap already paid and did not deposit twice. 0.00125 ZEC arrived as one shielded note.',
    zcashTxid: 'd826f2d9747992fbb242f40d5705359db75e3b56bd522175a75cfa416bc96643',
  },
]

export const zcashMainnetUrl = (txid: string): string => `https://mainnet.zcashexplorer.app/transactions/${txid}`
export const solanaMainnetUrl = (sig: string): string => `https://explorer.solana.com/tx/${sig}`
