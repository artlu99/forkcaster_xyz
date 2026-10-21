import './App.css'
import { siGithub, siGithubsponsors } from 'simple-icons'

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
