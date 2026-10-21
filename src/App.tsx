import './App.css'
import { siGithub, siGithubsponsors } from 'simple-icons'
import { useEffect, useState } from 'preact/hooks'

function AutoToggle() {
  const [auto, setAuto] = useState<'on' | 'off' | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const m = document.cookie.match(/(?:^|; )fc_client=([^;]*)/)
    // Cookie values may be percent-encoded (server Set-Cookie encodes
    // "|" as %7C).
    let v = ''
    try {
      v = m ? decodeURIComponent(m[1]) : ''
    } catch {
      v = m ? m[1] : ''
    }
    const sep = v.indexOf('|')
    const flag = sep === -1 ? '' : v.slice(sep + 1)
    if (flag === 'auto-on') setAuto('on')
    if (flag === 'auto-off') setAuto('off')
  }, [])
  const set = (next: 'on' | 'off') => {
    setAuto(next)
    setSaved(true)
    fetch('/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auto: next }),
    }).catch(() => {})
  }
  return (
    <p className="auto-toggle">
      <span className="auto-label">auto-open</span>
      <button type="button" aria-pressed={auto === 'on'} onClick={() => set('on')}>On</button>
      <button type="button" aria-pressed={auto === 'off'} onClick={() => set('off')}>Off</button>
      <span className="auto-note">
        {saved ? 'saved' : 'cast pages open in your last-used app'}
      </span>
    </p>
  )
}

function App() {
  return (
    <>
      <section id="center">
        <p className="eyebrow">Farcaster, unfurled</p>
        <h1>forkcaster</h1>
        <p className="lede">
          Every Farcaster cast, one clean link away — rendered straight from
          the chain. No app, no login.
        </p>
        <div className="examples">
          <a className="example" href="/darrylyeo/0xa7c5f470">
            <span className="path">/darrylyeo/0xa7c5f470</span>
            <span className="caption">signed author</span>
          </a>
          <a className="example" href="/cassie/0x934d79f6">
            <span className="path">/cassie/0x934d79f6</span>
            <span className="caption">unsigned author</span>
          </a>
        </div>
        <p className="lede footnote">
          Pages link to various Farcaster clients. Authors who haven't signed
          Farcaster's social smart contract are read-only in some of them,
          so their pages skip any app that requires signing.
        </p>
        <AutoToggle />
        <p className="repo-link">
          <a href="https://github.com/artlu99/forkcaster_xyz">
            <span
              className="repo-mark"
              dangerouslySetInnerHTML={{ __html: siGithub.svg }}
            />
            MIT license
          </a>{' '}
          <span aria-hidden="true">·</span>{' '}
          <a href="https://github.com/artlu99/forkcaster_xyz/tree/main?tab=contributing-ov-file">
            <span
              className="repo-mark"
              dangerouslySetInnerHTML={{ __html: siGithubsponsors.svg }}
            />
            Contributing
          </a>{' '}
          <span aria-hidden="true">·</span>{' '}
          <a href="/transparency">Transparency</a>
        </p>
      </section>
      <div className="ticks"></div>
    </>
  )
}

export default App
