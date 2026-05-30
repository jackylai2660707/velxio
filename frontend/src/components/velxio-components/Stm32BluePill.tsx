import './Stm32BluePillElement';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'velxio-stm32-bluepill': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      'velxio-stm32-blackpill': React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}

interface Props {
  id: string;
  x: number;
  y: number;
}

/** Thin React wrappers over the STM32 board Web Components (rule 6a). */
export const Stm32BluePill = ({ id, x, y }: Props) => (
  <velxio-stm32-bluepill id={id} style={{ position: 'absolute', left: x, top: y }} />
);

export const Stm32BlackPill = ({ id, x, y }: Props) => (
  <velxio-stm32-blackpill id={id} style={{ position: 'absolute', left: x, top: y }} />
);
