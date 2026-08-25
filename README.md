# @mrk-us/create-app

Interactive Bun CLI for composing projects from
[`mrk-us/starter-boilerplate`](https://github.com/mrk-us/starter-boilerplate).

Requires Bun 1.3.14 or newer and Node.js 22.11 or newer. The CLI checks the
`node` executable on `PATH` before starting the prompts.

On the current development machine, activate the installed Node.js 22 runtime
with:

```sh
export PATH="$HOME/Library/Application Support/Herd/config/nvm/versions/node/v22.16.0/bin:$PATH"
node --version
```

## Local development

Install dependencies:

```sh
bun install
```

Run against a local template checkout:

```sh
CREATE_APP_TEMPLATE_PATH=/Users/markus/Dev/starter-boilerplate bun run dev
```

The CLI creates the project in the current directory. The template checkout
must have its dependencies installed because the current composer uses its
local Biome executable.

Use `--skip-install` while iterating on prompts and file composition. It also
skips the generated project's checks and provider setup:

```sh
CREATE_APP_TEMPLATE_PATH=/Users/markus/Dev/starter-boilerplate \
  bun run dev --skip-install
```

Use `--skip-provision` to install and validate a generated project without
creating cloud resources:

```sh
CREATE_APP_TEMPLATE_PATH=/Users/markus/Dev/starter-boilerplate \
  bun run dev --skip-provision
```

## Development provider setup

Selections that include Convex now continue into provider setup after the
source passes static checks. Before creating anything, the CLI lists the
resources and asks for confirmation.

The complete WorkOS, Resend, and Stripe selection does the following:

1. Creates a Convex project and cloud development deployment.
2. Uses Convex's AuthKit development integration to create and configure the
   WorkOS environment.
3. Creates the WorkOS webhook for the generated Convex HTTP endpoint.
4. Stores the entered full-access Resend API key for the generated app and uses
   it to create the Resend webhook. Enter it through the masked prompt or
   supply it as `CREATE_APP_RESEND_API_KEY`.
5. Asks whether to use a sandbox from the Stripe Dashboard or create a
   temporary claimable sandbox. The Dashboard path is the default. It directs
   you to the sandbox manager and asks for a sandbox test API key. The
   temporary path prints its claim link before setup continues and can switch
   to a Dashboard sandbox if claiming is unavailable.
6. Adds the Pro product, the `pro_monthly` USD 8 price, the `pro_yearly` USD 80
   price, a customer portal configuration, and the required webhook to the
   selected Stripe sandbox.
7. Writes ignored local environment files at `.env.local`,
   `apps/app/.env.local`, and `packages/backend/.env.local`. Server secrets are
   also stored on the Convex development deployment.
8. Pushes the configured Convex functions once more so `bun run dev` can start
   with the complete environment.

The default `onboarding@resend.dev` sender only delivers to the email address
associated with the Resend account. Use a sender on a verified domain for other
recipients.

Stripe automatic tax is not enabled. Configure registrations and tax behavior
before using the billing flow in production.

Stripe does not require live account activation to use a Dashboard sandbox.
Create one from the account picker under Switch to sandbox > Manage sandboxes,
then copy a restricted test key from Developers > API keys. A standard
`sk_test_` sandbox key also works, but a restricted key is preferable.

Setup progress lives in the ignored `.starter/setup-state.json`. The file
contains resource IDs and stage status, not API keys or webhook secrets. Resume
an interrupted local run with:

```sh
bun run /Users/markus/Dev/create-app/src/index.ts --resume ./acme-books
```

The published command is:

```sh
bunx @mrk-us/create-app --resume ./acme-books
```

## Local `bunx` test

Register the package once:

```sh
bun link
```

Then link it into a scratch project and invoke the package by its published
name:

```sh
mkdir -p /tmp/create-app-consumer
cd /tmp/create-app-consumer
bun init -y
bun link @mrk-us/create-app --no-save
CREATE_APP_TEMPLATE_PATH=/Users/markus/Dev/starter-boilerplate \
  bunx --bun --no-install @mrk-us/create-app
```

Run `bun unlink` in this repository when the link is no longer needed.

## Checks

```sh
bun run validate
```

## Package rehearsal

```sh
bun pm pack
```

Install the resulting tarball in a clean scratch project to test the published
`create-app` executable without publishing it.

Provider prompts enforce the V1 dependency rules. The setup only creates
development resources. It does not create production deployments, live Stripe
resources, domains, or deployment-platform configuration.
