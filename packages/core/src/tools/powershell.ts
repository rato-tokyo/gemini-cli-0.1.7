/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Config } from '../config/config.js';
import {
  BaseTool,
  ToolResult,
  ToolCallConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationOutcome,
} from './tools.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { getErrorMessage } from '../utils/errors.js';

import stripAnsi from 'strip-ansi';
import { spawn } from 'child_process';

const OUTPUT_UPDATE_INTERVAL_MS = 1000;

export interface PowerShellToolParams {
  command: string;
  description?: string;
  directory?: string;
}

export class PowerShellTool extends BaseTool<PowerShellToolParams, ToolResult> {
  static Name: string = 'run_powershell_command';
  private whitelist: Set<string> = new Set();

  constructor(private readonly config: Config) {
    super(
      PowerShellTool.Name,
      'PowerShell',
      `This tool executes a given PowerShell command as \`pwsh.exe -Command <command>\`. Command can start background processes using \`&\`. Command is executed as a subprocess that leads its own process group. Command process group can be terminated as \`Stop-Process -Id <PGID> -Force\` or signaled as \`Stop-Process -Id <PGID> -Force\`.\n\nThe following information is returned:\n\nCommand: Executed command.\nDirectory: Directory (relative to project root) where command was executed, or \`(root)\`.\nStdout: Output on stdout stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.\nStderr: Output on stderr stream. Can be \`(empty)\` or partial on error and for any unwaited background processes.\nError: Error or \`(none)\` if no error was reported for the subprocess.\nExit Code: Exit code or \`(none)\` if terminated by signal.\nSignal: Signal number or \`(none)\` if no signal was received.\nBackground PIDs: List of background processes started or \`(none)\`.\nProcess Group PGID: Process group started or \`(none)\``,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Exact PowerShell command to execute as \`pwsh.exe -Command <command>\`',
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) Directory to run the command in, if not the project root directory. Must be relative to the project root directory and must already exist.',
          },
        },
        required: ['command'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  getDescription(params: PowerShellToolParams): string {
    let description = `${params.command}`;
    if (params.directory) {
      description += ` [in ${params.directory}]`;
    }
    if (params.description) {
      description += ` (${params.description.replace(/\n/g, ' ')})`;
    }
    return description;
  }

  getCommandRoot(command: string): string | undefined {
    return command
      .trim()
      .replace(/[{}()]/g, '')
      .split(/[\s;&|]+/)[0]
      ?.split(/[\\/]/)
      .pop();
  }

  validateToolParams(params: PowerShellToolParams): string | null {
    if (
      !SchemaValidator.validate(
        this.parameterSchema as Record<string, unknown>,
        params,
      )
    ) {
      return `Parameters failed schema validation.`;
    }
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }
    if (!this.getCommandRoot(params.command)) {
      return 'Could not identify command root to obtain permission from user.';
    }
    if (params.directory) {
      if (path.isAbsolute(params.directory)) {
        return 'Directory cannot be absolute. Must be relative to the project root directory.';
      }
      const directory = path.resolve(
        this.config.getTargetDir(),
        params.directory,
      );
      if (!fs.existsSync(directory)) {
        return 'Directory must exist.';
      }
    }
    return null;
  }

  async shouldConfirmExecute(
    params: PowerShellToolParams,
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (this.validateToolParams(params)) {
      return false;
    }
    const rootCommand = this.getCommandRoot(params.command)!;
    if (this.whitelist.has(rootCommand)) {
      return false;
    }
    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm PowerShell Command',
      command: params.command,
      rootCommand,
      onConfirm: async (outcome: ToolConfirmationOutcome) => {
        if (outcome === ToolConfirmationOutcome.ProceedAlways) {
          this.whitelist.add(rootCommand);
        }
      },
    };
    return confirmationDetails;
  }

  async execute(
    params: PowerShellToolParams,
    abortSignal: AbortSignal,
    updateOutput?: (chunk: string) => void,
  ): Promise<ToolResult> {
    const validationError = this.validateToolParams(params);
    if (validationError) {
      return {
        llmContent: [
          `Command rejected: ${params.command}`,
          `Reason: ${validationError}`,
        ].join('\n'),
        returnDisplay: `Error: ${validationError}`,
      };
    }

    if (abortSignal.aborted) {
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    const command = params.command;

    const shell = spawn('pwsh.exe', ['-Command', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.resolve(this.config.getTargetDir(), params.directory || ''),
    });

    let exited = false;
    let stdout = ''; // For LLM (stripped)
    let rawStdout = ''; // For user (raw)
    let stderr = ''; // For LLM (stripped)
    let rawStderr = ''; // For user (raw)
    let output = ''; // For user (raw, combined)
    let lastUpdateTime = Date.now();

    const appendOutput = (str: string) => {
      output += str;
      if (
        updateOutput &&
        Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS
      ) {
        updateOutput(output);
        lastUpdateTime = Date.now();
      }
    };

    shell.stdout.on('data', (data: Buffer) => {
      if (!exited) {
        const rawStr = data.toString();
        const strippedStr = stripAnsi(rawStr);
        rawStdout += rawStr;
        stdout += strippedStr;
        appendOutput(rawStr);
      }
    });

    shell.stderr.on('data', (data: Buffer) => {
      if (!exited) {
        const rawStr = data.toString();
        const strippedStr = stripAnsi(rawStr);
        rawStderr += rawStr;
        stderr += strippedStr;
        appendOutput(rawStr);
      }
    });

    let error: Error | null = null;
    shell.on('error', (err: Error) => {
      error = err;
      error.message = error.message.replace(command, params.command);
    });

    let code: number | null = null;
    let processSignal: NodeJS.Signals | null = null;
    const exitHandler = (
      _code: number | null,
      _signal: NodeJS.Signals | null,
    ) => {
      exited = true;
      code = _code;
      processSignal = _signal;
    };
    shell.on('exit', exitHandler);

    const abortHandler = async () => {
      if (shell.pid && !exited) {
        // For Windows, use taskkill to kill the process tree
        spawn('taskkill', ['/pid', shell.pid.toString(), '/f', '/t']);
      }
    };
    abortSignal.addEventListener('abort', abortHandler);

    try {
      await new Promise((resolve) => shell.on('exit', resolve));
    } finally {
      abortSignal.removeEventListener('abort', abortHandler);
    }

    // Trim trailing newlines from accumulated output
    stdout = stdout.trimEnd();
    stderr = stderr.trimEnd();
    output = output.trimEnd();

    let llmContent = '';
    if (abortSignal.aborted) {
      llmContent = 'Command was cancelled by user before it could complete.';
      if (output.trim()) {
        llmContent += ` Below is the output (on stdout and stderr) before it was cancelled:\n${output}`;
      } else {
        llmContent += ' There was no output before it was cancelled.';
      }
    } else {
      llmContent = [
        `Command: ${params.command}`,
        `Directory: ${params.directory || '(root)'}`,
        `Stdout: ${stdout || '(empty)'}`,
        `Stderr: ${stderr || '(empty)'}`,
        `Error: ${error ?? '(none)'}`,
        `Exit Code: ${code ?? '(none)'}`,
        `Signal: ${processSignal ?? '(none)'}`,
        `Background PIDs: (none)`,
        `Process Group PGID: ${shell.pid ?? '(none)'}`,
      ].join('\n');
    }

    let returnDisplayMessage = '';
    if (this.config.getDebugMode()) {
      returnDisplayMessage = llmContent;
    } else {
      if (output.trim()) {
        returnDisplayMessage = output;
      } else {
        if (abortSignal.aborted) {
          returnDisplayMessage = 'Command cancelled by user.';
        } else if (processSignal) {
          returnDisplayMessage = `Command terminated by signal: ${processSignal}`;
        } else if (error) {
          returnDisplayMessage = `Command failed: ${getErrorMessage(error)}`;
        } else if (code !== null && code !== 0) {
          returnDisplayMessage = `Command exited with code: ${code}`;
        }
      }
    }

    return { llmContent, returnDisplay: returnDisplayMessage };
  }
}