import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export interface PromptChoice<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export interface Prompter {
  text(options: {
    message: string;
    defaultValue?: string;
    validate?: (value: string) => string | undefined;
  }): Promise<string>;
  select<T extends string>(options: {
    message: string;
    choices: Array<PromptChoice<T>>;
    defaultValue?: T;
  }): Promise<T>;
  confirm(options: { message: string; defaultValue?: boolean }): Promise<boolean>;
  close?(): void;
}

export function createReadlinePrompter(input: Readable, output: Writable): Prompter {
  const rl = readline.createInterface({ input, output });

  return {
    async text({ message, defaultValue, validate }) {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      while (true) {
        const answer = await rl.question(`${message}${suffix}: `);
        const resolved = answer.trim() || defaultValue || "";
        const error = validate?.(resolved);
        if (!error) {
          return resolved;
        }
        output.write(`  ${error}\n`);
      }
    },

    async select({ message, choices, defaultValue }) {
      output.write(`${message}\n`);
      const defaultIndex = Math.max(
        0,
        choices.findIndex((choice) => choice.value === defaultValue),
      );
      choices.forEach((choice, index) => {
        const marker = index === defaultIndex ? "*" : " ";
        const hint = choice.hint ? ` (${choice.hint})` : "";
        output.write(` ${marker} ${index + 1}) ${choice.label}${hint}\n`);
      });

      while (true) {
        const answer = await rl.question(`Select [1-${choices.length}] (${defaultIndex + 1}): `);
        const trimmed = answer.trim();
        if (!trimmed) {
          return choices[defaultIndex].value;
        }
        const num = Number(trimmed);
        if (Number.isInteger(num) && num >= 1 && num <= choices.length) {
          return choices[num - 1].value;
        }
        const byValue = choices.find(
          (choice) => choice.value.toLowerCase() === trimmed.toLowerCase(),
        );
        if (byValue) {
          return byValue.value;
        }
        output.write(`  Enter a number between 1 and ${choices.length}.\n`);
      }
    },

    async confirm({ message, defaultValue = false }) {
      const hint = defaultValue ? "[Y/n]" : "[y/N]";
      while (true) {
        const answer = (await rl.question(`${message} ${hint}: `)).trim().toLowerCase();
        if (!answer) {
          return defaultValue;
        }
        if (answer === "y" || answer === "yes") {
          return true;
        }
        if (answer === "n" || answer === "no") {
          return false;
        }
        output.write("  Please answer yes or no.\n");
      }
    },

    close() {
      rl.close();
    },
  };
}
