import { useEffect, useState } from 'preact/hooks'
import { siGithub, siGithubsponsors } from 'simple-icons'
import './App.css'

function delayNote(delay: number): string {
  if (delay === 0) return 'casts redirect immediately to your last-used app'
  const unit = delay === 1 ? 'second' : 'seconds'
  return `casts redirect to your last-used app after ${delay} ${unit}`
}

function delayValueText(delay: number): string {
  if (delay === 0) return 'immediately'
  return delay === 1 ? '1 second' : `${delay} seconds`
}

function AutoToggle() {
  const [auto, setAuto] = useState<'on' | 'off' | undefined>(undefined)
  const [delay, setDelay] = useState(5)
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
    v = v.replace(/%7C/gi, '|')
    const sep = v.indexOf('|')
    if (sep === -1) return
    for (const part of v.slice(sep + 1).split('|')) {
      if (part === 'auto-on') setAuto('on')
      else if (part === 'auto-off') setAuto('off')
      else if (/^d[0-5]$/.test(part)) setDelay(Number(part.slice(1)))
    }
  }, [])
  const save = (body: { auto?: 'on' | 'off'; delay?: number }) => {
    fetch('/prefs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
  }
  const set = (next: 'on' | 'off') => {
    setAuto(next)
    save({ auto: next, delay })
  }
  const commitDelay = (next: number) => {
    setDelay(next)
    save(auto ? { auto, delay: next } : { delay: next })
  }
  return (
    <div className="auto-prefs">
      <p className="auto-toggle">
        <span className="auto-label">auto-open</span>
        <button type="button" aria-pressed={auto === 'on'} onClick={() => set('on')}>On</button>
        <button type="button" aria-pressed={auto === 'off'} onClick={() => set('off')}>Off</button>
      </p>
      <label className="auto-delay">
        <span className="auto-label">delay</span>
        <input
          type="range"
          min={0}
          max={5}
          step={1}
          value={delay}
          aria-valuetext={delayValueText(delay)}
          style={{ '--fill': `${(delay / 5) * 100}%` }}
          onInput={(e) => setDelay(Number(e.currentTarget.value))}
          onChange={(e) => commitDelay(Number(e.currentTarget.value))}
        />
        <span className="auto-delay-value" aria-hidden="true">{delay}s</span>
      </label>
      <p className="auto-note">{delayNote(delay)}</p>
    </div>
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
