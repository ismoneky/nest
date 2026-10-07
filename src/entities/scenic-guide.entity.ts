import { Column, Entity, PrimaryColumn } from 'typeorm';

/** One versioned document keeps the background and its image-space points atomic. */
@Entity('scenic_guides')
export class ScenicGuide {
    @PrimaryColumn({ type: 'integer' })
    id: number;

    @Column({ type: 'text' })
    contentJson: string;

    @Column({ type: 'integer', default: 1 })
    revision: number;

    @Column({ type: 'integer' })
    updatedAt: number;
}
