import { describe, expect, it } from 'vitest';
import {
  IDLE_THRESHOLD_SECONDS,
  resolvePetState,
} from './petState';

describe('resolvePetState priority', () => {
  it('is chilling by default (no active state)', () => {
    expect(
      resolvePetState({
        panelOpen: false,
        bubbleVisible: false,
        hoverOrDrag: false,
        idleSeconds: 0,
      }),
    ).toBe('chilling');
  });

  it('is sleepy after 10s without interaction', () => {
    expect(
      resolvePetState({
        panelOpen: false,
        bubbleVisible: false,
        hoverOrDrag: false,
        idleSeconds: IDLE_THRESHOLD_SECONDS,
      }),
    ).toBe('sleepy');
  });

  it('stays chilling just under the idle threshold', () => {
    expect(
      resolvePetState({
        panelOpen: false,
        bubbleVisible: false,
        hoverOrDrag: false,
        idleSeconds: IDLE_THRESHOLD_SECONDS - 0.5,
      }),
    ).toBe('chilling');
  });

  it('is happy while hovering or dragging', () => {
    expect(
      resolvePetState({
        panelOpen: false,
        bubbleVisible: false,
        hoverOrDrag: true,
        idleSeconds: 0,
      }),
    ).toBe('happy');
  });

  it('is nervous while a notification bubble is visible', () => {
    expect(
      resolvePetState({
        panelOpen: false,
        bubbleVisible: true,
        hoverOrDrag: false,
        idleSeconds: 0,
      }),
    ).toBe('nervous');
  });

  it('is focused while the task panel is open', () => {
    expect(
      resolvePetState({
        panelOpen: true,
        bubbleVisible: false,
        hoverOrDrag: false,
        idleSeconds: 999,
      }),
    ).toBe('focused');
  });

  it('focused beats nervous, happy, and sleepy combined', () => {
    expect(
      resolvePetState({
        panelOpen: true,
        bubbleVisible: true,
        hoverOrDrag: true,
        idleSeconds: 999,
      }),
    ).toBe('focused');
  });

  it('nervous beats happy and sleepy (hover during a bubble stays nervous)', () => {
    expect(
      resolvePetState({
        panelOpen: false,
        bubbleVisible: true,
        hoverOrDrag: true,
        idleSeconds: 999,
      }),
    ).toBe('nervous');
  });

  it('happy beats sleepy (hovering after idling stays happy, not sleepy)', () => {
    expect(
      resolvePetState({
        panelOpen: false,
        bubbleVisible: false,
        hoverOrDrag: true,
        idleSeconds: 999,
      }),
    ).toBe('happy');
  });
});
