# Project Agent Confirmation Gate

**Date:** 2026-05-18

## The Problem
Project-local agents are repo-controlled code and therefore fundamentally untrusted. `pi-subagent` implements a confirmation gate (`confirmProjectAgents: true` by default) to ensure users approve their execution.

Initially, `ctx.hasUI` was assumed to indicate a local interactive terminal session where a user could manually approve the prompt. However, Pi's `ctx.hasUI` is also `true` in RPC mode because the RPC protocol supports extension UI requests. An automated or headless RPC client could auto-answer `true` to `ctx.ui.confirm()`, silently bypassing the security gate.

## The Decision
We chose a **strict fail-closed gate** for the default behavior:
- We rely on `process.stdin.isTTY === true && process.stdout.isTTY === true && process.stdin.isRaw === true` combined with `ctx.hasUI` as the heuristic for a genuine local TUI.
- If this heuristic is not met (e.g., in RPC, headless, or API modes), execution **throws an error** when attempting to run a project-local agent with `confirmProjectAgents: true`.

## Why Not `ctx.ui.confirm` with a Timeout?
Using `ctx.hasUI` and adding a timeout to `ctx.ui.confirm()` would reintroduce the vulnerability: an RPC client could still auto-answer the protocol request immediately. Pi currently exposes no `ctx.mode`, `ctx.ui.kind`, or `clientCapabilities` to cryptographically or programmatically guarantee that a real human clicked "Approve".

## The Contract for API/RPC Clients
Clients that embed Pi and wish to support project-local agents must:
1. Catch the resulting error or intercept the payload early.
2. Present their own human consent was obtained.
3. Pass `confirmProjectAgents: false` to explicitly assert that trust was established.

This keeps the default safe while preserving the ability for advanced clients to run project agents.
