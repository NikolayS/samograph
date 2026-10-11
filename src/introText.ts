// Default self-introduction the bot posts in meeting chat (`samograph intro`
// or `join --intro`). English on purpose: at join time there is no transcript
// yet to detect the call's language, so a neutral default avoids guessing
// wrong. Override with `--intro-text` to post a custom (e.g. localized) one.
export const DEFAULT_INTRO_TEXT =
  "Hi, I'm Leo, a samograph assistant bot \u{1F916} During the call I follow the " +
  "live transcript and can help in real time: post messages here in chat (with " +
  "a soft chime), show my status on the bot camera, capture the screen-share or " +
  "a participant's video on request, and keep shared notes in a Google Doc. " +
  "Just mention me in chat if you need anything.";
