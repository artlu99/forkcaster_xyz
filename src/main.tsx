/**
 * Landing entry. Mounts the SPA shell (App) on #root.
 *
 * Domain model this site documents:
 * - Not banned: the account signed an onchain smart contract that granted
 *   its address a soulbound NFT; Farcaster APIs return its data.
 * - Banned: Farcaster APIs return no data, so cast pages here fall back to
 *   a "may be banned" notice with a direct farcaster.xyz link.
 *
 * Only the landing page is client-rendered; cast pages are SSR'd by the worker.
 */
import { render } from 'preact'
import { StrictMode } from 'preact/compat'
import './index.css'
import App from './App.tsx'

const root = document.getElementById('root')

if (root) {
  render(
    <StrictMode>
      <App />
    </StrictMode>,
    root,
  )
}
