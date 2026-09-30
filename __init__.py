"""Hermes plugin entry point. Clone this repository into ~/.hermes/plugins/."""


def register(ctx):
    from .hermes_cloudflare_sandbox.provider import CloudflareSandboxProvider

    ctx.register_terminal_environment_provider(CloudflareSandboxProvider())
