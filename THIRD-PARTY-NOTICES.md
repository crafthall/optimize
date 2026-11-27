# Third-party notices

Crafthall Optimize is licensed under the MIT License (see [LICENSE](LICENSE)).

The command-line client (`dist/crafthall-optimize.mjs`) is one file bundled from Crafthall Optimize's own source: the
CLI and its engine, both under the same MIT License and copyright. It contains no third-party code and the package has
no runtime dependencies. At run time it uses only Node.js built-in modules and starts these programs already installed
on your machine: `claude` (Claude Code), `git`, and the success command you give a fixture (with the `--version` of
the tools that command names).

Claude and Claude Code are trademarks of Anthropic. Crafthall Optimize is not affiliated with or endorsed by Anthropic.
