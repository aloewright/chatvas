```markdown
# chatvas Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `chatvas` repository, a React-based JavaScript project. You'll learn about file naming, import/export styles, commit conventions, and how to write and organize tests. This guide is designed to help contributors quickly align with the project's established practices.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `chatPanel.js`, `userInputHandler.js`

### Import Style
- Use **relative imports** for modules within the project.
  - Example:
    ```javascript
    import ChatPanel from './chatPanel';
    import { sendMessage } from '../utils/messageUtils';
    ```

### Export Style
- Use **named exports** for modules and components.
  - Example:
    ```javascript
    // chatPanel.js
    export function ChatPanel(props) {
      // component code
    }
    ```

### Commit Patterns
- Commit messages are **freeform** and may include various prefixes.
- Average commit message length: **63 characters**.
  - Example:
    ```
    Add basic chat panel component and initial state management
    ```

## Workflows

_No automated workflows detected in the repository._

## Testing Patterns

- **Test file pattern:** Files end with `.test.*` (e.g., `chatPanel.test.js`).
- **Testing framework:** Not explicitly detected; check project dependencies for details.
- **Test organization:** Test files are colocated with implementation or in dedicated test directories.

  Example test file:
  ```javascript
  // chatPanel.test.js
  import { render, screen } from '@testing-library/react';
  import { ChatPanel } from './chatPanel';

  test('renders chat panel', () => {
    render(<ChatPanel />);
    expect(screen.getByText(/Chat/)).toBeInTheDocument();
  });
  ```

## Commands

| Command | Purpose |
|---------|---------|
| /test   | Run all tests in the project (suggested) |
| /lint   | Lint the codebase (if configured) |
| /build  | Build the project for production (if applicable) |
```