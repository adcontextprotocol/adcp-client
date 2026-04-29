module.exports = {
  extends: ['@commitlint/config-conventional'],
  parserPreset: 'conventional-changelog-conventionalcommits',
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // New feature
        'fix', // Bug fix
        'docs', // Documentation only
        'style', // Code style changes (formatting, missing semicolons, etc)
        'refactor', // Code refactoring
        'perf', // Performance improvements
        'test', // Adding or updating tests
        'build', // Changes to build system or dependencies
        'ci', // Changes to CI configuration
        'chore', // Other changes that don't modify src or test files
        'revert', // Reverts a previous commit
      ],
    ],
    'scope-empty': [0], // Allow empty scope
    'subject-case': [0], // Don't enforce subject case
    'body-max-line-length': [0], // Disable body line length limit
    // Raised from default 100 to 120. Long-running review-round commits
    // ("address round-N review — ...") legitimately need the breathing
    // room for the scope + colon + dash-separated items. 100 forces
    // truncation that loses the bullet; 120 accommodates without making
    // headers unreadable.
    'header-max-length': [2, 'always', 120],
    // Disabled: bodies that legitimately use lines like `Status: …` get
    // parsed as trailers, then the next paragraph triggers a false-positive
    // "footer must have leading blank line" warning. The rule is stylistic;
    // letting it gate CI on parser edge-cases is more friction than benefit.
    'footer-leading-blank': [0],
  },
};
