export interface ComponentTemplate {
  type: 'led' | 'resistor' | 'pushbutton' | 'potentiometer';
  label: string;
  icon: string;
  defaultProperties: {
    color?: string;
    value?: number;
    pin?: number;
  };
}

export type ComponentType = 'led' | 'resistor' | 'pushbutton' | 'potentiometer';

export interface ComponentProperties {
  color?: string;
  value?: number;
  pin?: number;
  state?: boolean;
}

export interface Component {
  id: string;
  /** Canvas components use metadataId; legacy palette callers use type. */
  metadataId?: string;
  /** Optional legacy palette discriminator. */
  type?: ComponentType;
  x: number;
  y: number;
  properties: ComponentProperties;
}
