import {
  IconArrowDown, IconArrowLeft, IconArrowRight, IconArrowUp, IconArrowBackUp,
  IconArrowForwardUp, IconArrowsMaximize, IconArrowsMinimize, IconBold, IconBrush,
  IconCamera, IconCheck, IconCircle, IconCopy, IconCurrencyDollar, IconDownload,
  IconEraser, IconFileText, IconHeading, IconHistory, IconItalic, IconLayersLinked,
  IconLayoutGrid, IconList, IconMicrophone, IconMovie, IconPlayerPause,
  IconPlayerPlay, IconRectangle, IconRotate, IconScissors, IconSparkles,
  IconTrash, IconUpload, IconUsers, IconUserPlus, IconLink, IconUnlink,
  IconInfoCircle, IconVolume, IconVolumeOff, IconX,
} from "@tabler/icons-react";

const icons = {
  arrowDown: IconArrowDown, arrowLeft: IconArrowLeft, arrowRight: IconArrowRight,
  arrowUp: IconArrowUp, undo: IconArrowBackUp, redo: IconArrowForwardUp,
  expand: IconArrowsMaximize, collapse: IconArrowsMinimize, bold: IconBold,
  brush: IconBrush, camera: IconCamera, check: IconCheck, circle: IconCircle,
  copy: IconCopy, cost: IconCurrencyDollar, download: IconDownload,
  eraser: IconEraser, text: IconFileText, heading: IconHeading, history: IconHistory,
  italic: IconItalic, merge: IconLayersLinked, grid: IconLayoutGrid, list: IconList,
  microphone: IconMicrophone, movie: IconMovie, pause: IconPlayerPause,
  play: IconPlayerPlay, rectangle: IconRectangle, reset: IconRotate,
  cut: IconScissors, generate: IconSparkles, trash: IconTrash, upload: IconUpload,
  users: IconUsers, invite: IconUserPlus, link: IconLink, unlink: IconUnlink,
  info: IconInfoCircle, volume: IconVolume, mute: IconVolumeOff, close: IconX,
};

export type NodeIconName = keyof typeof icons;

export default function NodeIcon({ name, size = 16 }: { name: NodeIconName; size?: number }) {
  const Icon = icons[name];
  return <Icon className="nodeIcon" size={size} stroke={1.6} aria-hidden="true" focusable="false" />;
}
