"use client";

import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Divider,
  FictionLabel,
  Heading,
  IconButton,
  Input,
  Label,
  Link,
  Price,
  ProductArt,
  ProgressBar,
  Radio,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Tag,
  Text,
  Textarea,
  VisuallyHidden,
} from "@delulu/ui";
import { Level, Specimen } from "./Specimen";

export function AtomsSection() {
  return (
    <Level id="atoms" title="Atoms" intro="Single-purpose elements. They import nothing from higher levels.">
      <Specimen title="Button">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button disabled>Disabled</Button>
        <Button loading>Loading</Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
      </Specimen>
      <Specimen title="IconButton">
        <IconButton aria-label="Close demo">
          <span aria-hidden="true">×</span>
        </IconButton>
        <IconButton aria-label="Disabled demo" disabled>
          <span aria-hidden="true">+</span>
        </IconButton>
      </Specimen>
      <Specimen title="Link">
        <Link href="/">Back to the shop</Link>
      </Specimen>
      <Specimen title="Heading and Text">
        <div>
          <Heading level={2} size="md">
            A heading
          </Heading>
          <Text>Body text in the default size.</Text>
          <Text size="sm" muted>
            Small muted text.
          </Text>
        </div>
      </Specimen>
      <Specimen title="Label, Input and Textarea">
        <div className="flex w-full flex-col gap-1">
          <Label htmlFor="ds-input" required>
            Nickname
          </Label>
          <Input id="ds-input" placeholder="Pick a nickname" />
          <Label htmlFor="ds-invalid">Invalid input</Label>
          <Input id="ds-invalid" invalid defaultValue="oops" />
          <Label htmlFor="ds-textarea">Message</Label>
          <Textarea id="ds-textarea" placeholder="Say something" />
        </div>
      </Specimen>
      <Specimen title="Select">
        <div className="flex w-full flex-col gap-1">
          <Label htmlFor="ds-select">Delivery speed</Label>
          <Select id="ds-select" defaultValue="standard">
            <option value="standard">Standard</option>
            <option value="express">Express</option>
          </Select>
        </div>
      </Specimen>
      <Specimen title="Checkbox, Radio and Switch">
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Unchecked" />
        <Checkbox label="Invalid" invalid />
        <Radio name="ds-radio" label="Radio A" defaultChecked />
        <Radio name="ds-radio" label="Radio B" />
        <Switch aria-label="Switch on" defaultChecked />
        <Switch aria-label="Switch off" />
      </Specimen>
      <Specimen title="Badge">
        <Badge>Neutral</Badge>
        <Badge tone="success">Success</Badge>
        <Badge tone="warning">Warning</Badge>
        <Badge tone="danger">Danger</Badge>
        <Badge tone="info">Info</Badge>
        <Badge tone="highlight">Highlight</Badge>
      </Specimen>
      <Specimen title="Tag">
        <Tag>Plain tag</Tag>
        <Tag onRemove={() => {}} removeLabel="Remove Impossible Tech">
          Impossible Tech
        </Tag>
      </Specimen>
      <Specimen title="Avatar">
        <Avatar name="Asha Rao" size="sm" />
        <Avatar name="Velvet Rope Co" />
        <Avatar name="Pocket Comet" size="lg" />
      </Specimen>
      <Specimen title="Spinner, Skeleton and ProgressBar">
        <Spinner />
        <Skeleton className="h-6 w-40" />
        <ProgressBar label="Order progress" value={60} className="w-full" />
      </Specimen>
      <Specimen title="Divider and VisuallyHidden">
        <div className="w-full">
          <Divider />
          <Text size="sm" muted>
            Screen readers hear a hidden note after this line.<VisuallyHidden> (hidden note)</VisuallyHidden>
          </Text>
        </div>
      </Specimen>
      <Specimen title="Price and FictionLabel">
        <Price amountPaise={199_900n} />
        <Price amountPaise={20_000_000_00n} />
        <Price amountPaise={100_000_000_000_00n} display="exact" />
        <FictionLabel />
      </Specimen>
      <Specimen title="ProductArt">
        {[0, 70, 140, 210, 280].map((hue) => (
          <ProductArt
            key={hue}
            hue={hue}
            seed={`demo-${hue}`}
            alt={`Generated artwork, hue ${hue}`}
            className="w-24"
          />
        ))}
      </Specimen>
    </Level>
  );
}
