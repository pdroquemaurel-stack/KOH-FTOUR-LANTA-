// public/js/types.js
// Constantes d'événements et JSDoc des payloads

export const EVENTS = {
  MODE_CHANGED: 'mode:changed',
  ROOM_PLAYERS: 'room:players',
  SCORES_RESET: 'scores:reset',
  ROUND_RESET: 'round:reset',
  COUNTDOWN_START: 'countdown:start',

  // Buzzer
  BUZZ_OPEN: 'round:open',
  BUZZ_WINNER: 'round:winner',

  // Quiz
  QUIZ_QUESTION: 'quiz:question',
  QUIZ_RESULT: 'quiz:result',

  // Guess
  GUESS_START: 'guess:start',
  GUESS_PROGRESS: 'guess:progress',
  GUESS_RESULT: 'guess:result',

  // Free
  FREE_QUESTION: 'free:question',
  FREE_RESULTS: 'free:results',
  FREE_VALIDATED: 'free:validated',
  FREE_REVIEW_OPEN: 'free:review_open',
  FREE_REVIEW_VALIDATED: 'free:review_validated',

  // Qui est le plus
  MOST_QUESTION: 'most:question',
  MOST_RESULT: 'most:result',
};

// Normalisation côté TV: événements "génériques" utilisés par les modules
export const GAME_EVENTS = {
  QUESTION: 'game:question',   // { question, seconds, ... }
  PROGRESS: 'game:progress',   // payload libre (ex: histogramme)
  RESULT: 'game:result',       // payload libre
  CLOSE: 'game:close',         // sans payload
};

/**
 * @typedef {Object} PlayerItem
 * @property {string} name
 * @property {number} score
 * @property {boolean} [connected]
 */

/**
 * @typedef {Object} QuizQuestionPayload
 * @property {string} question
 * @property {number} seconds
 */

/**
 * @typedef {Object} GuessStartPayload
 * @property {string} question
 * @property {number} min
 * @property {number} max
 * @property {number} seconds
 */

/**
 * @typedef {Object} FreeQuestionPayload
 * @property {string} question
 * @property {number} seconds
 * @property {number} [index]
 * @property {number} [total]
 */
