// The prompt of a question to the Agent of a Task in a dead end. Shared with the client: the feed shows
// only the human's text of such a message, without the note in front of it.

// Goes in front of the human's text: the Agent learns that its Task is over and it is asked to explain,
// not to carry on with the work.
export const DEAD_END_QUESTION_NOTE = [
  "[Оркестратор] Задача в Тупике: Оркестратор остановил её и передал человеку.",
  "Человек пишет тебе из веб-интерфейса, чтобы разобраться, что произошло.",
  "Ответь на его сообщение: что ты сделал, на чём остановился, в каком состоянии worktree и ветка.",
  "Не меняй код, не коммить и не пушь, пока человек явно об этом не попросит.",
  "ask_human сейчас не нужен: если хочешь что-то уточнить, спроси прямо в тексте ответа.",
].join(" ");

// What ask_human returns during such a Turn: the human reads the reply right now, there is no Request.
export const DEAD_END_ASK_HUMAN_ANSWER = "Задача в Тупике, человек читает твой ответ прямо сейчас. Задай вопрос в тексте ответа и закончи Ход.";

const HUMAN_MARK = "\n\nСообщение человека:\n\n";

export const deadEndQuestionPrompt = (text: string): string => `${DEAD_END_QUESTION_NOTE}${HUMAN_MARK}${text.trim()}`;

// The human's text of a question prompt, or undefined when the message is not one.
export const findDeadEndQuestion = (prompt: string): string | undefined =>
  prompt.startsWith(DEAD_END_QUESTION_NOTE + HUMAN_MARK) ? prompt.slice(DEAD_END_QUESTION_NOTE.length + HUMAN_MARK.length) : undefined;
