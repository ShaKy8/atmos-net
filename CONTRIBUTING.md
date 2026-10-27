# Contributing

Issues and pull requests are welcome. This is a small personal project, so
please open an issue before starting anything large.

## Running it

```
git clone https://github.com/ShaKy8/atmos-net
cd atmos-net
npm start            # http://localhost:7777
```

Node 20 or newer. There is no build step, bundler, linter or npm dependency, and
that is on purpose: please don't add one without talking to me first.
`CLAUDE.md` has a tour of the architecture, and the README covers configuration.

## Before you open a pull request

```
node --test tests/*.test.cjs
```

The tests are deterministic and need no network. They don't replace looking at
the result, so also run the server and load the page. `?q=0` to `?q=3` pins the
render quality, and a hash such as `#radar` deep-links a view.

If you touch `public/wallpaper.html`, read the LAYOUT CONTRACT comment at the start
of its `<style>` block first: the companion [SYS//NET](https://github.com/ShaKy8/sysnet-hud) HUD lines
up with that block.

## Keep it in the same style

Plain ES modules and the existing comment density. One dead upstream should
degrade one panel, not the page. Routes are unauthenticated, so there are no CORS
headers on purpose.

## Security

Please don't report vulnerabilities as public issues. See [SECURITY.md](SECURITY.md).
