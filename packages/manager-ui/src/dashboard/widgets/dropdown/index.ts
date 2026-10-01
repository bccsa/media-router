import type { WidgetDef } from '../../registry';
import DropdownSelect from './DropdownSelect.vue';

export default {
    type: 'dropdown',
    label: 'Dropdown',
    icon: 'chevrons-up-down',
    order: 50,
    size: { w: 4, h: 2 },
    binds: 'value',
    control: true,
    accepts: (e) => Array.isArray(e.desc.enum) && e.desc.enum.length > 0 && e.desc.type !== 'array',
    options: [],
    component: DropdownSelect,
} satisfies WidgetDef;
