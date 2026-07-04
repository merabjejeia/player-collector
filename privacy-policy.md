# Privacy Policy — Player Collector

*Last updated: July 4, 2026*

---

## 1. Overview

Player Collector ("the Extension") is a browser extension that helps authorized team members collect and review player account data from internal admin systems. This policy explains what data the Extension accesses, how it is handled, and what your rights are.

---

## 2. Data the Extension Accesses

When you use the Extension, it fetches the following information from your authenticated admin session:

- Player names and account identifiers
- Deposit and withdrawal history (amounts, payment methods, transaction hashes)
- Wallet addresses associated with cryptocurrency deposits
- Login history (IP addresses, countries, device user-agents, ASN)
- Game activity records
- Sportsbook account data (betting history, account restrictions)

The Extension only accesses this data **when explicitly triggered by the user** (by clicking "Collect"). It does not run in the background, does not monitor browsing activity, and does not access any data outside of the admin panel domains listed in its permissions.

---

## 3. How Data Is Stored

All collected data is stored **locally in your browser** using the Chrome `storage.local` API. It is never transmitted to any server controlled by the Extension developer. Data persists between popup sessions for convenience and can be cleared at any time using the "Clear" button.

---

## 4. External Services

To resolve cryptocurrency transaction hashes to sender wallet addresses, the Extension makes requests to the following **public, read-only blockchain APIs**:

| Service | Purpose |
|---|---|
| TronScan API | TRON/TRC-20 transactions |
| Blockstream API | Bitcoin transactions |
| LitecoinSpace, Blockchair, BlockCypher | Litecoin transactions |
| Public EVM JSON-RPC nodes (Ankr, PublicNode, etc.) | ETH/BSC/Polygon/Base/Arbitrum/Optimism/Avalanche |
| Tonviewer | TON transactions |

Only the transaction hash is sent to these services. No personal player data, credentials, or account information is included in these requests.

---

## 5. Data Sharing

The Extension does **not**:
- Sell, share, or transfer any data to third parties
- Send collected data to any remote server
- Use data for analytics, advertising, or any purpose beyond displaying it to the user within the extension popup

---

## 6. Who Has Access

The Extension is intended for use by authorized employees only. Access is controlled by distribution — the extension is not publicly listed and is only available to users with a direct installation link.

---

## 7. Contact

If you have any questions about this privacy policy, contact:

**Merab Jejeia**
jejeiamerab@gmail.com
