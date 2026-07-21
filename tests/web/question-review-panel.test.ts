// @vitest-environment jsdom
/// <reference lib="dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuestionReviewPanel } from '../../web/src/app.js';
import type { Bundle } from '../../web/src/contracts.js';

const questions: Bundle['openQuestions'] = [
  {
    id: 'question-1',
    question: 'Who approved the emergency failover?',
  },
  {
    id: 'question-2',
    question: 'When was the provider notified?',
  },
];

afterEach(cleanup);

describe('QuestionReviewPanel', () => {
  it('keeps one complete question and its answer field visible at a time', () => {
    const onQuestionAnswerChange = vi.fn();
    render(
      createElement(QuestionReviewPanel, {
        editable: true,
        onQuestionAnswerChange,
        questionAnswers: { 'question-1': '', 'question-2': '' },
        questions,
      }),
    );

    expect(
      screen.getByRole('textbox', {
        name: 'Answer: Who approved the emergency failover?',
      }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Question 2: needs answer',
      }),
    );

    const secondAnswer = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Answer: When was the provider notified?',
    });
    fireEvent.change(secondAnswer, { target: { value: 'At 10:14 UTC.' } });

    expect(onQuestionAnswerChange).toHaveBeenCalledExactlyOnceWith(
      'question-2',
      'At 10:14 UTC.',
    );
  });
});
