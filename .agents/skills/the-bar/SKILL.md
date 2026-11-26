---
name: the-bar
description: Use whenever you scope, plan or design something a person or an agent meets (a screen, a menu, settings, a command, an action, an MCP tool, an API's output), especially when the request hands you a reference product's items, a service's functions or an API's fields. Turns the list into jobs, cuts first, and has a fresh agent check the plan before you show it.
---

# The bar

Would the people who made the Mac and the iPhone ship it? Plan in this order, and show your plan in this shape ([design craft](https://ui.ouroboros.bot/docs/design-craft/#the-bar)).

1. **Jobs.** Write what people do here, in their words (for an agent door, what people ask agents to do), before you plan anything. Read a reference product's items, a service's functions and an API's fields as evidence of jobs, never as the list to build.
2. **Cut first.** Go through every item you were given, one line each: the job it serves, or cut and why (a right default does it, the device or system already does it where people look, another kept item covers the same job, or no one's job needs it). One way in per job, not one per item or function; extend what exists before adding another way.
3. **Build what is left well**, from the product's own components and patterns. Keep the basics people use daily and build them properly, for the person and for agents: name the one command, action or tool each job gets, not one per item, function or on and off state. Make its result say what it did, and each failure say what happened and the next command to run.
4. **Proof.** Name the fresh people or fresh agents, the real job they will do, and what you will watch for. Passing tests is the floor, not the proof. Run them again after each small change.
5. **Check.** Before you show the plan, start a fresh agent that didn't write it (a subagent, such as the task tool). Give it the request and your plan, and ask it to check every item against steps 1 to 4 and to flag anything that is a reference's item rather than a job, a second way in, or a job people do every day that you cut or deferred. Fix what it finds, then show the plan.

Keep restraint for what no job needs: never cut or defer a job people do every day.
