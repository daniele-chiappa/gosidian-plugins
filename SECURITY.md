# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in one of these plugins,
please report it **privately** through this repository's Security
Advisory channel, not in a public issue: the repository's **Security**
tab, **"Report a vulnerability"** (`./security/advisories/new` from the
repository's root). An issue of gosidian itself goes to
[gosidian's](https://github.com/daniele-chiappa/gosidian/security/advisories/new).

Include a description and the impact you foresee, the steps to reproduce
it, the plugin and its version (`GET /health` gives it), and how you'd
like to be credited. We acknowledge new advisories within **72 hours**
and follow gosidian's [policy](https://github.com/daniele-chiappa/gosidian/blob/main/SECURITY.md)
for triage, fixes and disclosure.

## Supported versions

The latest release of each plugin.

## Scope

In scope: the plugins' code and their published images, above all how
they hold their credentials (a storage source's keys), how they fetch the
files gosidian hands them, and the URLs they serve.

Out of scope: the stores, servers and models a plugin talks to, and the
infrastructure around it.
